const { sendDirectMessage } = require('./_lib/heartbeat');

async function sendSplitMessages(recipientId, response) {
  const parts = response.split('[SPLIT]').map(p => p.trim()).filter(p => p.length > 0);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      const delay = Math.min(600 + parts[i].length * 12, 1400);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    await sendDirectMessage(recipientId, parts[i]);
  }
}
const { callOpenAI } = require('./_lib/charlie');
const { supabase } = require('./_lib/supabase');
const { pickSuggestedLessons, formatSuggestionsContext } = require('./_lib/suggestions');

const CHARLIE_USER_ID = '4123ccdd-a337-4438-b5ff-fcaad1464102';
const MAX_MESSAGES_PER_RUN = 15; // Safety cap — prevent mass messaging

// ═══════════════════════════════════════════════════════════
// FIX 3: Message archetypes — Charlie rotates between these
// ═══════════════════════════════════════════════════════════
const MESSAGE_ARCHETYPES = [
  'celebration',     // Celebrate something specific they did
  'curiosity',       // Ask a genuine question about their learning/life
  'observation',     // Share a pattern you noticed (without pressure)
  'micro-challenge', // Tiny optional challenge ("try X today")
  'dream-thread',    // Connect today's moment to their bigger dream
  'resource-nudge',  // Gently surface a tool or lesson
  'warmth-only',     // Pure warmth, zero agenda — just "thinking of you"
  'reflection'       // Invite them to reflect on something they learned
];

// ═══════════════════════════════════════════════════════════
// HELPER: Extract recent tool usage from student_hub JSONB
// Returns array of tool names used in last 7 days
// ═══════════════════════════════════════════════════════════
function getRecentToolUsage(hubData) {
  if (!hubData) return [];
  
  const tools = [];
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  
  // Check each tool's JSONB field for recent activity
  const toolChecks = [
    { name: 'The Word Bank', field: 'fluency_vault' },
    { name: 'Alex', field: 'conversation_training' },
    { name: 'Lucy', field: 'writing_coach' },
    { name: 'The Hartley Diaries', field: 'hartley_files' },
    { name: 'The Reading Room', field: 'reading_room' }
  ];
  
  for (const tool of toolChecks) {
    const data = hubData[tool.field];
    if (!data) continue;
    
    // Check for any timestamp field indicating recent activity
    // Tools may have: last_activity, updated_at, last_reviewed, created_at
    const possibleDateFields = ['last_activity', 'updated_at', 'last_reviewed', 'created_at', 'last_attempted'];
    let hasRecentActivity = false;
    
    if (typeof data === 'object' && data !== null) {
      // Check all date fields in the JSONB object
      for (const field of possibleDateFields) {
        if (data[field]) {
          const actDate = new Date(data[field]);
          if (actDate > sevenDaysAgo) {
            hasRecentActivity = true;
            break;
          }
        }
      }
    }
    
    if (hasRecentActivity) {
      tools.push(tool.name);
    }
  }
  
  return tools;
}

/**
 * HELPER: Detect which tools student hasn't used yet
 * Returns array of tool names unused since enrollment
 */
function getUnusedTools(hubData) {
  if (!hubData) return ['The Word Bank', 'Alex', 'Lucy', 'The Hartley Diaries', 'The Reading Room'];
  
  const allTools = [
    { name: 'The Word Bank', field: 'fluency_vault' },
    { name: 'Alex', field: 'conversation_training' },
    { name: 'Lucy', field: 'writing_coach' },
    { name: 'The Hartley Diaries', field: 'hartley_files' },
    { name: 'The Reading Room', field: 'reading_room' }
  ];
  
  const unused = [];
  for (const tool of allTools) {
    const data = hubData[tool.field];
    // If field is missing or completely empty, it's unused
    if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
      unused.push(tool.name);
    }
  }
  return unused;
}

/**
 * HELPER: Determine if student is in "tool discovery phase"
 * First 14 days: aggressive tool exploration
 * After 14 days: sustainable check-ins with occasional nudges
 */
function isInToolDiscoveryPhase(daysSinceJoined) {
  return daysSinceJoined !== null && daysSinceJoined <= 14;
}

/**
 * POST /api/morning-checkin
 * Called at 09:00 Romanian time by Tasklet schedule trigger.
 *
 * Charlie reviews each student's situation and decides who needs a message today.
 * 
 * AUDIT FIXES IMPLEMENTED:
 * 1. Unanswered message cap (3 max) — stop messaging if student hasn't responded
 * 2. Engagement-adaptive frequency — adjust gap based on activity level
 * 3. Message archetypes with rotation — never repeat the same type twice
 * 4. Question ratio (1 in 3) — include questions to invite conversation
 * 5. Return-moment escalation — acknowledge patterns in returning students
 * 6. Familiarity progression — Day 29 sounds different from Day 1
 * 7. Tool avoidance gentle mention — notice when they skip relevant tools
 * 8. Score decay for repeated signals — "never chatted" loses weight over time
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();
  const summary = {
    studentsEvaluated: 0,
    messagesSent: 0,
    skipped: 0,
    skippedReasons: {},
    errors: []
  };

  try {
    console.log('[Morning] Starting Charlie morning check-in...');

    // --- Get all active students directly from our own table (source of truth) ---
    // No Heartbeat dependency for the member list — students exist when they join
    // or complete the survey. Heartbeat is only used for DM delivery.
    const { data: studentRecords, error: studentsError } = await supabase
      .from('students')
      .select('*')
      .eq('active', true);

    if (studentsError) {
      console.error('[Morning] Failed to fetch students:', studentsError.message);
      return res.status(500).json({ error: studentsError.message });
    }

    const allStudents = studentRecords || [];
    console.log(`[Morning] Evaluating ${allStudents.length} active students`);

    // --- Get student_hub data (financial + learning health) ---
    const { data: hubRecords } = await supabase
      .from('student_hub')
      .select('email, health_status, plan, activity_status, learning_streak, tools_active, total_learning_mins, fluency_vault, reading_room, hartley_files, conversation_training, last_study_date');
    const hubMap = {};
    if (hubRecords) {
      for (const h of hubRecords) {
        if (h.email) hubMap[h.email] = h;
      }
    }

    // --- Get recent activity from activity_log (last 30 days for engagement calc) ---
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split('T')[0];
    const { data: recentActivity } = await supabase
      .from('activity_log')
      .select('user_id, activity_type, activity_date, metadata')
      .gte('activity_date', thirtyDaysAgo)
      .order('activity_date', { ascending: false });

    // Build per-user activity summary
    const activityMap = {};
    if (recentActivity) {
      for (const a of recentActivity) {
        if (!activityMap[a.user_id]) {
          activityMap[a.user_id] = {
            posts: 0,
            courseCompletions: [],
            lastPostDate: null,
            lastCourseDate: null,
            activeDays: new Set(),  // FIX 2: Track unique active days
            loginDates: []
          };
        }
        activityMap[a.user_id].activeDays.add(a.activity_date);
        if (a.activity_type === 'POST') {
          activityMap[a.user_id].posts++;
          if (!activityMap[a.user_id].lastPostDate) activityMap[a.user_id].lastPostDate = a.activity_date;
        }
        if (a.activity_type === 'COURSE_COMPLETE') {
          activityMap[a.user_id].courseCompletions.push(a.metadata?.course_name || 'curs');
          if (!activityMap[a.user_id].lastCourseDate) activityMap[a.user_id].lastCourseDate = a.activity_date;
        }
        if (a.activity_type === 'LOGIN') {
          activityMap[a.user_id].loginDates.push(a.activity_date);
        }
      }
    }

    // --- Score each student ---
    const scored = [];

    for (const studentRow of allStudents) {
      // Skip Charlie himself and students without a Heartbeat ID (can't DM them yet)
      if (studentRow.heartbeat_id === CHARLIE_USER_ID) continue;
      if (!studentRow.heartbeat_id) continue;

      // Build a member-like object so the rest of the scoring code is unchanged
      const member = {
        heartbeat_id: studentRow.heartbeat_id,
        first_name: studentRow.first_name || (studentRow.name || '').split(' ')[0],
        name: studentRow.name || '',
        email: studentRow.email || '',
        groups: studentRow.groups || [],   // already stored as text[] in students table
        created_at: studentRow.created_at,
        is_admin: false,
      };

      // Skip students with no-access group (legacy or manually set)
      const groups = member.groups.map(g => typeof g === 'string' ? g : g.name || '');
      if (groups.some(g => g.toLowerCase() === 'no access')) {
        summary.skipped++;
        trackSkipReason(summary, 'no-access');
        continue;
      }

      summary.studentsEvaluated++;

      // studentData IS the student row — no separate map lookup needed
      const studentData = studentRow;
      const activityData = activityMap[studentRow.heartbeat_id] || {
        posts: 0, courseCompletions: [], lastPostDate: null, lastCourseDate: null,
        activeDays: new Set(), loginDates: []
      };
      const prefs = studentData.preferences || {};

      // --- Preference hard overrides ---

      // Student said they're away → skip until they return
      if (prefs.away_until) {
        const awayUntil = new Date(prefs.away_until);
        if (new Date() <= awayUntil) {
          summary.skipped++;
          trackSkipReason(summary, 'away');
          continue;
        }
      }

      // Student said no morning messages → skip entirely
      if (prefs.no_morning_messages === true) {
        summary.skipped++;
        trackSkipReason(summary, 'opted-out');
        continue;
      }

      // Student said no weekends → skip on Saturday (6) and Sunday (0)
      if (prefs.no_weekends === true) {
        const romanianNow = new Date(Date.now() + 2 * 3600 * 1000);
        const dayOfWeek = romanianNow.getUTCDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          summary.skipped++;
          trackSkipReason(summary, 'no-weekends');
          continue;
        }
      }

      // ═══════════════════════════════════════════════
      // FIX 1: Unanswered message cap — 3 max
      // ═══════════════════════════════════════════════
      const unansweredCount = studentData.charlie_unanswered_count || 0;
      if (unansweredCount >= 3 && !prefs.always_checkin) {
        summary.skipped++;
        trackSkipReason(summary, 'unanswered-cap');
        console.log(`[Morning] ⛔ Skipping ${member.first_name} — ${unansweredCount} unanswered messages (cap: 3)`);
        continue;
      }

      // Student said always contact them → boost score significantly
      const alwaysBoost = prefs.always_checkin === true ? 100 : 0;

      // FIX 2: Calculate engagement-adaptive minimum gap
      const activeDaysCount = activityData.activeDays.size;
      const score = calculatePriorityScore(member, studentData, activityData, activeDaysCount) + alwaysBoost;

      if (score > 0) {
        scored.push({
          member,
          studentData,
          activityData,
          hubData: hubMap[studentRow.email] || {},
          prefs,
          score,
          activeDaysCount,
          reason: buildReason(member, studentData, activityData, prefs)
        });
      }
    }

    // Sort by priority (highest first), cap at MAX_MESSAGES_PER_RUN
    scored.sort((a, b) => b.score - a.score);
    const toMessage = scored.slice(0, MAX_MESSAGES_PER_RUN);

    console.log(`[Morning] ${scored.length} students flagged, messaging top ${toMessage.length}`);

    // --- Generate and send messages ---
    for (const { member, studentData, activityData, hubData, prefs, reason, activeDaysCount } of toMessage) {
      try {
        const message = await generateProactiveMessage(member, studentData, activityData, reason, prefs || {}, hubData || {}, activeDaysCount);
        if (!message) {
          summary.skipped++;
          continue;
        }

        await sendSplitMessages(member.heartbeat_id, message);

        // FIX 3: Detect which archetype was used (approximate from content)
        const detectedArchetype = detectArchetypeFromMessage(message);

        // FIX 5: Detect return-from-silence
        const isReturn = detectReturnFromSilence(studentData, activityData);

        // Update student record with new tracking fields
        await supabase
          .from('students')
          .upsert({
            heartbeat_id: member.heartbeat_id,
            student_id: member.heartbeat_id,
            email: member.email || '',
            name: member.name || '',
            last_charlie_proactive: new Date().toISOString(),
            // FIX 1: Increment unanswered count
            charlie_unanswered_count: (studentData.charlie_unanswered_count || 0) + 1,
            // FIX 3: Track archetype for rotation
            last_message_archetype: detectedArchetype,
            // FIX 5: Increment return count if this is a return
            return_count: isReturn
              ? (studentData.return_count || 0) + 1
              : (studentData.return_count || 0)
          }, { onConflict: 'heartbeat_id' });

        summary.messagesSent++;
        console.log(`[Morning] ✓ Messaged ${member.first_name || member.heartbeat_id} (score: ${scored.find(s => s.member.heartbeat_id === member.heartbeat_id)?.score}, archetype: ${detectedArchetype}, unanswered: ${(studentData.charlie_unanswered_count || 0) + 1}) — ${reason}`);

        // Small delay between messages to avoid rate limiting
        await sleep(500);
      } catch (err) {
        summary.errors.push(`${member.heartbeat_id}: ${err.message}`);
        console.error(`[Morning] Failed to message ${member.first_name}:`, err.message);
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[Morning] Complete in ${elapsed}s:`, summary);

    return res.status(200).json({
      success: true,
      elapsed_seconds: elapsed,
      ...summary
    });
  } catch (err) {
    console.error('[Morning] Fatal error:', err.message);
    return res.status(500).json({ error: err.message, summary });
  }
};

/**
 * Track skip reasons for better logging
 */
function trackSkipReason(summary, reason) {
  summary.skippedReasons[reason] = (summary.skippedReasons[reason] || 0) + 1;
}

/**
 * ═══════════════════════════════════════════════════════════
 * FIX 2: Engagement-adaptive frequency
 * ═══════════════════════════════════════════════════════════
 * Instead of a flat 3-day minimum gap, the gap adjusts based on how
 * active the student has been in the last 30 days:
 * 
 *   Active days (30d)  | Minimum gap | Reasoning
 *   ─────────────────────────────────────────────
 *   20+                | 10 days     | They're doing great, don't hover
 *   10-19              | 5 days      | Moderate — periodic encouragement
 *   5-9                | 4 days      | Slipping — gentle attention
 *   1-4                | 7 days      | Near-absent — max 4 msgs/month
 *   0                  | 7 days      | Gone — very occasional "door is open"
 */
function getAdaptiveMinGap(activeDaysCount, daysSinceJoined) {
  // New students (first 7 days) always get shorter gaps
  if (daysSinceJoined !== null && daysSinceJoined <= 7) return 2;
  
  if (activeDaysCount >= 20) return 10;  // Highly active — back off
  if (activeDaysCount >= 10) return 5;   // Moderate
  if (activeDaysCount >= 5) return 4;    // Slipping
  return 7;                               // Near-absent or absent
}

/**
 * Calculate priority score (0 = skip, higher = more urgent)
 * 
 * FIX 2: Uses adaptive gap instead of flat 3 days
 * FIX 8: Decays repeated signals over time
 */
function calculatePriorityScore(member, studentData, activityData = {}, activeDaysCount = 0) {
  const now = Date.now();

  // --- BLOCK conditions (return 0 immediately) ---

  const joinedAt = member.created_at ? new Date(member.created_at) : null;
  const daysSinceJoined = joinedAt
    ? Math.floor((now - joinedAt.getTime()) / (24 * 3600 * 1000))
    : 999;

  // FIX 2: Adaptive minimum gap based on engagement
  const minGap = getAdaptiveMinGap(activeDaysCount, daysSinceJoined);

  if (studentData.last_charlie_proactive) {
    const daysSinceProactive = Math.floor(
      (now - new Date(studentData.last_charlie_proactive).getTime()) / (24 * 3600 * 1000)
    );
    if (daysSinceProactive < minGap) return 0;
  }

  // If student chatted with Charlie in the last 24 hours → skip (they're engaged)
  if (studentData.last_interaction) {
    const hoursSinceInteraction = Math.floor(
      (now - new Date(studentData.last_interaction).getTime()) / (3600 * 1000)
    );
    if (hoursSinceInteraction < 24) return 0;
  }

  let score = 0;
  const groups = (member.groups || []).join(' ').toLowerCase();

  // --- Days since joining ---
  if (daysSinceJoined <= 3) score += 9;       // Brand new — always check in
  else if (daysSinceJoined <= 7) score += 7;   // First week
  else if (daysSinceJoined <= 14) score += 4;  // Second week

  // --- Activity signals from Heartbeat groups ---
  if (groups.includes('inactive')) score += 5;
  if (groups.includes('streak stop')) score += 3;
  if (groups.includes('starter streak')) score += 2;

  // --- Login history ---
  const lastLoginDate = studentData.last_login_date;
  if (lastLoginDate) {
    const daysSinceLogin = Math.floor(
      (now - new Date(lastLoginDate).getTime()) / (24 * 3600 * 1000)
    );
    if (daysSinceLogin >= 7) score += 5;
    else if (daysSinceLogin >= 3) score += 3;
    else if (daysSinceLogin <= 1) score -= 2; // Logged in recently, lower priority
  } else if (daysSinceJoined > 7) {
    // No login history and not new → they've been absent
    score += 3;
  }

  // --- Charlie interaction history ---
  // FIX 8: Score decay for repeated signals
  // "Never chatted with Charlie" decays: full points first month, then tapers
  if (studentData.last_interaction) {
    const daysSinceChat = Math.floor(
      (now - new Date(studentData.last_interaction).getTime()) / (24 * 3600 * 1000)
    );
    if (daysSinceChat >= 14) score += 2; // Long time since any chat
  } else if (daysSinceJoined > 3) {
    // FIX 8: Decay — "never chatted" matters less over time
    // Week 1-2: +3, Week 3-4: +2, Month 2+: +1, Month 3+: 0
    if (daysSinceJoined <= 14) score += 3;
    else if (daysSinceJoined <= 30) score += 2;
    else if (daysSinceJoined <= 60) score += 1;
    // After 60 days of never chatting — they've made their choice, stop scoring for it
  }

  // --- Community activity signals ---
  // Active poster → lower priority (they're engaged)
  if (activityData.posts >= 3) score -= 3;
  else if (activityData.posts === 0 && daysSinceJoined > 7) {
    // FIX 8: "Never posted" also decays
    if (daysSinceJoined <= 30) score += 2;
    else if (daysSinceJoined <= 60) score += 1;
    // After 60 days — stop nudging about community posting
  }

  // Recently completed a course → great for a celebratory nudge
  if (activityData.courseCompletions && activityData.courseCompletions.length > 0) {
    const daysSinceCourse = activityData.lastCourseDate
      ? Math.floor((now - new Date(activityData.lastCourseDate).getTime()) / (24 * 3600 * 1000))
      : 999;
    if (daysSinceCourse <= 2) score += 4; // Just completed — worth acknowledging
  }

  return Math.max(score, 0);
}

/**
 * Build a human-readable reason for the check-in (for logging)
 */
function buildReason(member, studentData, activityData = {}, prefs = {}) {
  const reasons = [];
  if (prefs.always_checkin) reasons.push('student requested daily check-in');
  const now = Date.now();
  const groups = (member.groups || []).join(' ').toLowerCase();

  const joinedAt = member.created_at ? new Date(member.created_at) : null;
  const daysSinceJoined = joinedAt
    ? Math.floor((now - joinedAt.getTime()) / (24 * 3600 * 1000))
    : 999;

  if (daysSinceJoined <= 7) reasons.push(`new member (day ${daysSinceJoined})`);
  if (groups.includes('inactive')) reasons.push('inactive group');
  if (groups.includes('streak stop')) reasons.push('streak stopped');
  if (studentData.last_login_date) {
    const days = Math.floor((now - new Date(studentData.last_login_date).getTime()) / (24 * 3600 * 1000));
    if (days >= 3) reasons.push(`${days}d since last login`);
  }
  if (!studentData.last_interaction && daysSinceJoined > 3) reasons.push('never chatted with Charlie');
  if (activityData.posts === 0 && daysSinceJoined > 7) reasons.push('never posted in community');
  if (activityData.courseCompletions?.length > 0) reasons.push(`recently completed: ${activityData.courseCompletions[0]}`);

  return reasons.join(', ') || 'general check-in';
}

/**
 * ═══════════════════════════════════════════════════════════
 * FIX 5: Detect return-from-silence
 * ═══════════════════════════════════════════════════════════
 * A "return" is when a student was absent 7+ days then showed activity
 * in the last 2 days. This means they came back.
 */
function detectReturnFromSilence(studentData, activityData) {
  if (!studentData.last_login_date) return false;
  
  const now = Date.now();
  const lastLogin = new Date(studentData.last_login_date);
  const daysSinceLogin = Math.floor((now - lastLogin.getTime()) / (24 * 3600 * 1000));
  
  // They logged in recently (0-2 days ago)
  if (daysSinceLogin > 2) return false;
  
  // But before that, there was a gap
  // Check if the previous activity before this login was 7+ days ago
  const sortedDates = Array.from(activityData.activeDays || []).sort().reverse();
  if (sortedDates.length < 2) return false;
  
  // Gap between most recent and second most recent activity
  const recent = new Date(sortedDates[0]);
  const previous = new Date(sortedDates[1]);
  const gapDays = Math.floor((recent - previous) / (24 * 3600 * 1000));
  
  return gapDays >= 7;
}

/**
 * ═══════════════════════════════════════════════════════════
 * FIX 7: Detect tool avoidance based on profile vs usage
 * ═══════════════════════════════════════════════════════════
 */
function detectToolAvoidance(onboarding, hubData, daysSinceJoined) {
  const avoidances = [];
  if (!onboarding || !hubData || daysSinceJoined < 14) return avoidances;
  
  const charlie = onboarding.charlie || {};
  const tags = charlie.tags || [];
  const dream = charlie.primary_dream || '';
  const answers = onboarding.answers || {};
  
  // Speaking dream but never used Alex
  const speakingDream = dream.toLowerCase().includes('vorb') || 
    dream.toLowerCase().includes('interviu') || 
    dream.toLowerCase().includes('conversaț') ||
    dream.toLowerCase().includes('speak') ||
    dream.toLowerCase().includes('interview') ||
    dream.toLowerCase().includes('confiden');
  
  if (speakingDream && !hubData.conversation_training) {
    avoidances.push({
      tool: 'Alex',
      reason: `Visul lor implică vorbire/conversație ("${dream.substring(0, 60)}") dar nu au încercat Alex`,
      gentle_hint: 'Menționează ușor — nu ca reproș, ci ca "ai știut că există X?"'
    });
  }
  
  // Vocabulary tagged as weak but Word Bank unused
  const skillRatings = answers.skill_ratings || {};
  const vocabWeak = (skillRatings.vocabulary && skillRatings.vocabulary <= 4);
  if (vocabWeak && !hubData.fluency_vault) {
    avoidances.push({
      tool: 'The Word Bank',
      reason: 'Vocabular auto-evaluat slab (≤4/10) dar The Word Bank nefolosit',
      gentle_hint: 'Sugerează natural, ca descoperire, nu ca prescripție'
    });
  }
  
  // Listening goal but never tried The Hartley Diaries
  const listeningDream = dream.toLowerCase().includes('ascult') || 
    dream.toLowerCase().includes('listen') ||
    dream.toLowerCase().includes('film') ||
    dream.toLowerCase().includes('serial') ||
    dream.toLowerCase().includes('înțeleg');
  const listeningWeak = (skillRatings.listening && skillRatings.listening <= 4);
  
  if ((listeningDream || listeningWeak) && !hubData.hartley_files) {
    avoidances.push({
      tool: 'The Hartley Diaries',
      reason: 'Ascultare slabă sau obiectiv de ascultare dar The Hartley Diaries nefolosit',
      gentle_hint: 'Prezintă ca ceva distractiv, nu ca lecție'
    });
  }
  
  // Reading weak but Reading Room unused
  const readingWeak = (skillRatings.reading && skillRatings.reading <= 4);
  if (readingWeak && !hubData.reading_room) {
    avoidances.push({
      tool: 'The Reading Room',
      reason: 'Citire auto-evaluată slab (≤4/10) dar Reading Room nefolosit',
      gentle_hint: 'Menționează ca opțiune relaxantă, nu ca cerință'
    });
  }
  

  // Writing goal or weak writing but Lucy unused
  const writingDream = dream.toLowerCase().includes('scri') ||
    dream.toLowerCase().includes('writ') ||
    dream.toLowerCase().includes('email') ||
    dream.toLowerCase().includes('eseu') ||
    dream.toLowerCase().includes('text');
  const writingWeak = (skillRatings.writing && skillRatings.writing <= 4);
  if ((writingDream || writingWeak) && !hubData.writing_coach) {
    avoidances.push({
      tool: 'Lucy',
      reason: 'Scriere slabă sau obiectiv de scriere dar Lucy nefolosită',
      gentle_hint: 'Prezintă ca antrenor de scriere, nu ca corector'
    });
  }
  return avoidances;
}

/**
 * ═══════════════════════════════════════════════════════════
 * FIX 6: Determine familiarity tier based on relationship length
 * ═══════════════════════════════════════════════════════════
 */
function getFamiliarityTier(daysSinceJoined, hasOnboarding) {
  if (daysSinceJoined <= 7) return {
    tier: 'new',
    instruction: `FAMILIARITATE: Student NOU (ziua ${daysSinceJoined}).
- Ton: Cald dar nu prea familiar — nu-l cunoști încă
- Dacă ai date de onboarding: referință specifică la ce au spus (arată că i-ai ascultat)
- Dacă nu ai onboarding: curiozitate sinceră despre cine sunt
- Semnează mereu: "— Charlie 👋"`
  };
  
  if (daysSinceJoined <= 30) return {
    tier: 'building',
    instruction: `FAMILIARITATE: Luna 1 (ziua ${daysSinceJoined}).
- Ton: Mai cald, începi să-l cunoști — poți face referințe la interacțiuni anterioare
- Nu mai e nevoie de introducere formală
- Poți fi mai direct și mai puțin ceremonios
- Semnătură variată: uneori "Charlie", uneori emoji, uneori nimic`
  };
  
  if (daysSinceJoined <= 90) return {
    tier: 'established',
    instruction: `FAMILIARITATE: Luna 2-3 (ziua ${daysSinceJoined}).
- Ton: Ca un prieten care te cunoaște — scurt, cald, direct
- Poți face referințe la pattern-urile lor ("știu că...")
- Mesajele pot fi mai scurte — relația e construită
- Poți provoca ușor dacă e necesar ("nu crezi că e momentul să...")`
  };
  
  return {
    tier: 'deep',
    instruction: `FAMILIARITATE: Veterani (ziua ${daysSinceJoined}).
- Ton: Shorthand de prieteni apropiați — nu mai e nevoie de context
- Poți fi direct, chiar provocator cu căldură
- Referințe la drumul parcurs împreună: "de la început ai..."
- Mesaje pot fi foarte scurte — o propoziție e suficientă
- Nu mai semnezi deloc — vă cunoașteți`
  };
}

/**
 * FIX 3: Detect archetype from generated message (heuristic)
 */
function detectArchetypeFromMessage(message) {
  const lower = message.toLowerCase();
  if (lower.includes('bravo') || lower.includes('felicit') || lower.includes('super') || lower.includes('genial')) return 'celebration';
  if (lower.includes('?') && (lower.includes('cum') || lower.includes('ce') || lower.includes('ai'))) return 'curiosity';
  if (lower.includes('am observat') || lower.includes('am văzut') || lower.includes('am remarcat')) return 'observation';
  if (lower.includes('încearcă') || lower.includes('provocare') || lower.includes('challenge')) return 'micro-challenge';
  if (lower.includes('vis') || lower.includes('obiectiv') || lower.includes('dream')) return 'dream-thread';
  if (lower.includes('alex') || lower.includes('lucy') || lower.includes('word bank') || lower.includes('hartley') || lower.includes('reading room')) return 'resource-nudge';
  if (lower.includes('reflectă') || lower.includes('gândește') || lower.includes('ce ai învățat')) return 'reflection';
  return 'warmth-only';
}

/**
 * Generate a personalised proactive message using OpenAI
 * 
 * Includes all 8 audit fixes in the prompt construction.
 */
async function generateProactiveMessage(member, studentData, activityData = {}, reason, prefs = {}, hubData = {}, activeDaysCount = 0) {
  try {
    const firstName = member.first_name || member.name || 'prietene';
    const now = Date.now();

    const joinedAt = member.created_at ? new Date(member.created_at) : null;
    const daysSinceJoined = joinedAt
      ? Math.floor((now - joinedAt.getTime()) / (24 * 3600 * 1000))
      : null;

    const daysSinceLogin = studentData.last_login_date
      ? Math.floor((now - new Date(studentData.last_login_date).getTime()) / (24 * 3600 * 1000))
      : null;

    const currentStreak = studentData.current_streak || 0;

    const groups = (member.groups || []).filter(g => {
      const gl = g.toLowerCase();
      return !gl.includes('member') && !gl.includes('log-in') && !gl.includes('active');
    });

    // ── Extract onboarding profile ──
    const onboarding = studentData.onboarding_responses || {};
    const charlieProfile = onboarding.charlie || {};
    const tags = charlieProfile.tags || [];
    const primaryDream = charlieProfile.primary_dream || null;
    const biggestBarrier = charlieProfile.biggest_barrier || null;
    const statedHoursPerWeek = onboarding.answers?.hours_per_week || null;
    const hasOnboarding = Object.keys(onboarding).length > 0;

    // ── Milestone detection ──
    const milestones = [];
    if (currentStreak === 7) milestones.push('7-zile-streak');
    if (currentStreak === 30) milestones.push('30-zile-streak');
    if (currentStreak === 100) milestones.push('100-zile-streak');
    if (activityData.courseCompletions?.length >= 1 && activityData.lastCourseDate) {
      const daysSinceFirst = Math.floor((now - new Date(activityData.lastCourseDate).getTime()) / (24 * 3600 * 1000));
      if (daysSinceFirst <= 2 && activityData.courseCompletions.length === 1) milestones.push('primul-curs');
    }
    if (hubData.fluency_vault && !hubData._vault_prev) milestones.push('primul-instrument');

    // ── Dream callback — surface every ~10-14 days ──
    let includeDreamCallback = false;
    if (primaryDream) {
      if (!studentData.last_charlie_proactive) {
        includeDreamCallback = true;
      } else {
        const daysSinceProactive = Math.floor(
          (now - new Date(studentData.last_charlie_proactive).getTime()) / (24 * 3600 * 1000)
        );
        if (daysSinceProactive >= 10) includeDreamCallback = true;
      }
    }

    // ── Recent tool usage (Option B: which tools, not specifics) ──
    const recentTools = getRecentToolUsage(hubData);

    // ── Pattern recognition — stated intentions vs actual behaviour ──
    const patternNotes = [];
    if (statedHoursPerWeek && parseInt(statedHoursPerWeek) >= 5 && daysSinceLogin >= 7) {
      patternNotes.push('a spus că are timp suficient dar nu s-a conectat — gap între intenție și realitate, abordează ușor, fără reproș');
    }
    if (tags.includes('time-short') && (!activityData.courseCompletions || activityData.courseCompletions.length === 0) && activityData.posts === 0) {
      patternNotes.push('timp limitat conform profilului — validează că orice micro-pas contează, nu pune presiune');
    }
    if (tags.includes('se-blochează') && activityData.courseCompletions?.length > 0) {
      patternNotes.push('profilul arată blocaj la vorbire dar avansează în cursuri — validează progresul concret');
    }
    if (tags.includes('lapsed') && daysSinceLogin >= 5) {
      patternNotes.push('a mai abandonat înainte — re-entry fără rușine, ton de "bine că ești înapoi", zero vinovăție');
    }

    // ═══════════════════════════════════════════════
    // FIX 5: Return-moment escalation
    // ═══════════════════════════════════════════════
    const returnCount = studentData.return_count || 0;
    const isReturning = detectReturnFromSilence(studentData, activityData);
    let returnContext = '';
    if (isReturning) {
      if (returnCount === 0) {
        returnContext = '🔄 PRIMA REVENIRE: Studentul revine după o pauză. Primire caldă și simplă — "Mă bucur!"';
      } else if (returnCount === 1) {
        returnContext = '🔄 A DOUA REVENIRE: Au mai revenit o dată. Recunoaște pattern-ul ușor: "Mă bucur că te întorci mereu" — fără "de ce pleci"';
      } else {
        returnContext = `🔄 REVENIRE #${returnCount + 1}: Au revenit de ${returnCount} ori. Recunoaște puterea de a reveni: "Faptul că revii de fiecare dată spune ceva important despre tine." Asta E progresul — persistența, nu perfecțiunea.`;
      }
    }

    // ═══════════════════════════════════════════════
    // FIX 6: Familiarity tier
    // ═══════════════════════════════════════════════
    const familiarity = getFamiliarityTier(daysSinceJoined || 999, hasOnboarding);

    // ═══════════════════════════════════════════════
    // FIX 7: Tool avoidance detection
    // ═══════════════════════════════════════════════
    const toolAvoidances = detectToolAvoidance(onboarding, hubData, daysSinceJoined || 0);
    let toolAvoidanceContext = '';
    if (toolAvoidances.length > 0) {
      // Only mention one per message to avoid overwhelm
      const avoidance = toolAvoidances[0];
      toolAvoidanceContext = `🔧 INSTRUMENT NEEXPLORAT: ${avoidance.tool} — ${avoidance.reason}. ${avoidance.gentle_hint}. Menționează DOAR dacă se potrivește natural în mesaj — nu forța.`;
    }

    // ═══════════════════════════════════════════════
    // FIX 3: Archetype rotation + tool discovery
    // ═══════════════════════════════════════════════
    const lastArchetype = studentData.last_message_archetype || 'none';
    const availableArchetypes = MESSAGE_ARCHETYPES.filter(a => a !== lastArchetype);
    
    // Tool discovery phase (first 14 days): boost resource-nudge if tools unused
    const inDiscoveryPhase = isInToolDiscoveryPhase(daysSinceJoined);
    const unusedTools = getUnusedTools(hubData);
    const shouldBoostToolNudge = inDiscoveryPhase && unusedTools.length > 0 && lastArchetype !== 'resource-nudge';
    
    // Weighted selection: prefer celebration > warmth on return > tool nudge in discovery > random
    let suggestedArchetype;
    if (milestones.length > 0) {
      suggestedArchetype = 'celebration';
    } else if (isReturning) {
      suggestedArchetype = 'warmth-only';
    } else if (shouldBoostToolNudge && Math.random() < 0.6) {
      // 60% chance of resource-nudge during discovery phase if tools unused
      suggestedArchetype = 'resource-nudge';
    } else {
      suggestedArchetype = availableArchetypes[Math.floor(Math.random() * availableArchetypes.length)];
    }

    // Build preferences context for the prompt
    const prefsLines = [];
    if (prefs.always_checkin) prefsLines.push('- Studentul a cerut să fie contactat în fiecare dimineață');
    if (prefs.preferred_language === 'english') prefsLines.push('- IMPORTANT: Studentul preferă să primească mesaje în ENGLEZĂ (nu română)');
    if (prefs.focus_area) prefsLines.push(`- Zona de focus aleasă de student: ${prefs.focus_area}`);
    if (prefs.goal) prefsLines.push(`- Obiectivul studentului: ${prefs.goal}`);

    const contextLines = [
      daysSinceJoined !== null ? `- Zile de la înregistrare: ${daysSinceJoined}` : null,
      currentStreak > 0 ? `- Streak curent: ${currentStreak} zile consecutive` : null,
      daysSinceLogin !== null ? `- Ultima autentificare: acum ${daysSinceLogin} zile` : '- Nu s-a autentificat recent',
      `- Zile active (ultimele 30): ${activeDaysCount}`,
      activityData.posts > 0 ? `- Postări în comunitate (ultimele 30 zile): ${activityData.posts}` : '- Nu a postat în comunitate recent',
      activityData.courseCompletions?.length > 0 ? `- Activitate de studiu recent: ${activityData.courseCompletions.length} lecție/lecții finalizate` : null,
      recentTools.length > 0 ? `- Instrumente folosite (ultimele 7 zile): ${recentTools.join(', ')}` : null,
      unusedTools.length > 0 && inDiscoveryPhase ? `- 🎯 FAZĂ DESCOPERIRE (primele 14 zile): Instrumente neexplorate: ${unusedTools.join(', ')}` : null,
      groups.length > 0 ? `- Cursuri/grupuri: ${groups.slice(0, 5).join(', ')}` : null,
      hubData.health_status ? `- Sănătate cont: ${hubData.health_status}` : null,
      hubData.plan ? `- Plan: ${hubData.plan}` : null,
      // Onboarding profile
      hasOnboarding && tags.length > 0 ? `- Profilul studentului [tags]: ${tags.join(', ')}` : null,
      hasOnboarding && primaryDream ? `- Visul/obiectivul declarat: "${primaryDream}"` : null,
      hasOnboarding && biggestBarrier ? `- Bariera principală: ${biggestBarrier}` : null,
      hasOnboarding && charlieProfile.charlie_opening_note ? `- Notă Charlie: ${charlieProfile.charlie_opening_note}` : null,
      // Milestones
      milestones.length > 0 ? `- ⭐ MILESTONE ATINS: ${milestones.join(', ')}` : null,
      // Pattern notes
      patternNotes.length > 0 ? `- 🔍 Observație comportamentală: ${patternNotes.join(' | ')}` : null,
      // Dream callback — handled ONLY via dream-thread archetype, not as separate flag
      // FIX 5: Return context
      returnContext ? `- ${returnContext}` : null,
      // FIX 7: Tool avoidance
      toolAvoidanceContext ? `- ${toolAvoidanceContext}` : null,
      // FIX 1: Unanswered count for context
      (studentData.charlie_unanswered_count || 0) > 0 ? `- ⚠️ Mesaje fără răspuns: ${studentData.charlie_unanswered_count} (fii mai scurt și mai lejer — nu insista)` : null,
      prefsLines.length > 0 ? `\nPreferințele studentului:\n${prefsLines.join('\n')}` : null,
      `- Motiv check-in: ${reason}`
    ].filter(Boolean).join('\n');

    // Detect if student is unengaged — offer gentle lesson suggestions
    const isUnengaged = (
      (daysSinceLogin !== null && daysSinceLogin >= 7) ||
      (member.groups || []).some(g => (typeof g === 'string' ? g : g.name || '').toLowerCase().includes('inactive'))
    ) && (daysSinceJoined === null || daysSinceJoined > 14);

    let suggestionsContext = '';
    if (isUnengaged) {
      const suggestions = await pickSuggestedLessons(member.groups || []);
      suggestionsContext = formatSuggestionsContext(suggestions, 'proactive');
    }

    // ── Archetype principles (intent, not templates) ──
    const archetypePrinciples = {
      celebration: `Acknowledge they did something. Warm, short.`,

      curiosity: `Ask one practical question about what they're doing.`,

      observation: `Notice one thing about their learning pattern. State as fact.`,

      'micro-challenge': `Suggest something small and optional.`,

      'dream-thread': `Connect a practical next step to their stated goal. Ask something concrete like "Ai încercat X?" or "Cum merge cu Y?" — NOT philosophical meaning questions like "ce înseamnă engleza pentru tine?" or "de ce contează asta?". Their why is theirs — don't probe it.`,

      'resource-nudge': `Offer practical help or mention something useful to them.`,

      'warmth-only': `Just check in. No agenda, no task. One sentence is enough.`,

      reflection: `Invite them to notice something they've learned or improved.`,
    };

    // ── Build the full prompt ──
    const familiarityInfo = getFamiliarityTier(daysSinceJoined || 999, hasOnboarding);

    const prompt = `Ești Charlie, tutore de engleză britanică pentru Engleza Britanică Academy. Ești cald, autentic, uman.
Tu ești mentorul lui ${firstName} — direct, cald, fără teatru. Un coleg care știe ce face și nu are nevoie să performeze grija.

PROFIL STUDENT:
${contextLines}
${suggestionsContext ? `\nSUGESTII LECȚII (dacă e relevant):\n${suggestionsContext}` : ''}

TIPUL MESAJULUI: ${suggestedArchetype.toUpperCase()}
${archetypePrinciples[suggestedArchetype] || ''}

${familiarityInfo.instruction}

REGULI ABSOLUTE:
1. SCRIE ÎN ROMÂNĂ. Excepție: nume proprii de instrumente (The Word Bank, Alex, The Hartley Diaries, The Reading Room).
2. Adresează-te DIRECT lui ${firstName}, nu generic.
3. SCURT: 1-3 propoziții maxim. O propoziție poate fi perfect suficientă. Lung nu înseamnă mai bun.
4. Ești un prieten, nu un cheerleader american. Tonul e cald și direct, nu performativ și efuziv.
5. Nu pune presiune, nu crea vinovăție, nu cere explicații pentru absențe.
6. NICIODATĂ nu numi lecții specifice ("Lecția 1" etc.) — Charlie nu știe ce conțin.
7. Charlie poate observa ce instrumente a folosit studentul recent fără să le recomande, cu excepția archetypului resource-nudge.
8. Semnează "Charlie" — fără "Cu căldură" sau "Cu entuziasm".
9. Variază salutările sau omite-le complet. Nu începe fiecare mesaj cu "Bună, ${firstName}!".
10. ÎNTREBĂRILE trebuie să fie practice, nu terapeutice. "Cu ce te-ai blocat?" e bun. "Cum te simți în legătură cu X?" e rău. "Ce înseamnă engleza pentru tine?" sau "De ce contează asta?" sunt INTERZISE — sunt interogatorii filosofice, nu check-in-uri.
11. NU inventa context care nu există în profil. Folosești DOAR ce apare explicit în datele studentului.
12. OFERTE PRACTICE: Poți oferi ajutor concret când apare natural — variat și autentic, nu formulaic.

VOICE PRINCIPLES (flexibilitate, nu reguli rigide):
- Mentor, nu sistem. Direct, cald, practic.
- Scurt mereu. O propoziție e adesea perfect suficientă.
- Variație constantă. Deschideri diferite, tipuri de întrebări diferite.
- Lasă-i să-și dețină visele — întreabă, nu picta scenarii pentru ei.
- Ajutorul practic e natural și variat — nu formulaic.

Scrie mesajul acum în română, variind tonul și abordarea natural:`;

    const text = await callOpenAI(
      [{ role: 'user', content: prompt }],
      { max_tokens: 300, temperature: 0.85 }
    );

    return text ? text.trim() : null;

  } catch (err) {
    console.error('[Morning] generateProactiveMessage error:', err.message);
    return null;
  }
}

/**
 * Simple sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
