const { getAllMembers, sendDirectMessage } = require('./_lib/heartbeat');

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

/**
 * POST /api/morning-checkin
 * Called at 09:00 Romanian time (07:00 UTC) by Tasklet schedule trigger.
 *
 * Charlie reviews each student's situation and decides who needs a message today.
 * Priority scoring based on:
 * - Days since joining (new students get more attention)
 * - Login activity (inactive students need encouragement)
 * - Last Charlie proactive message (avoid pestering)
 * - Active conversation (skip if they chatted today/yesterday)
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
    errors: []
  };

  try {
    console.log('[Morning] Starting Charlie morning check-in...');

    // --- Get all community members ---
    const members = await getAllMembers();
    console.log(`[Morning] Evaluating ${members.length} members`);

    // --- Get student records from Supabase (including preferences) ---
    const { data: studentRecords } = await supabase
      .from('students')
      .select('heartbeat_id, email, current_streak, longest_streak, last_login_date, last_charlie_proactive, last_interaction, preferences, onboarding_responses');

    const studentMap = {};
    if (studentRecords) {
      for (const s of studentRecords) {
        studentMap[s.heartbeat_id] = s;
      }
    }

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

    // --- Get recent activity from activity_log (last 14 days) ---
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString().split('T')[0];
    const { data: recentActivity } = await supabase
      .from('activity_log')
      .select('user_id, activity_type, activity_date, metadata')
      .gte('activity_date', fourteenDaysAgo)
      .order('activity_date', { ascending: false });

    // Build per-user activity summary
    const activityMap = {};
    if (recentActivity) {
      for (const a of recentActivity) {
        if (!activityMap[a.user_id]) {
          activityMap[a.user_id] = { posts: 0, courseCompletions: [], lastPostDate: null, lastCourseDate: null };
        }
        if (a.activity_type === 'POST') {
          activityMap[a.user_id].posts++;
          if (!activityMap[a.user_id].lastPostDate) activityMap[a.user_id].lastPostDate = a.activity_date;
        }
        if (a.activity_type === 'COURSE_COMPLETE') {
          activityMap[a.user_id].courseCompletions.push(a.metadata?.course_name || 'curs');
          if (!activityMap[a.user_id].lastCourseDate) activityMap[a.user_id].lastCourseDate = a.activity_date;
        }
      }
    }

    // --- Score each member ---
    const scored = [];

    for (const member of members) {
      if (member.heartbeat_id === CHARLIE_USER_ID) continue;
      if (member.is_admin) continue;
      if (!member.heartbeat_id) continue;

      // Skip "No access" users (not paying members)
      const groups = (member.groups || []).map(g => typeof g === 'string' ? g : g.name || '');
      if (groups.some(g => g.toLowerCase() === 'no access')) {
        summary.skipped++;
        continue;
      }

      summary.studentsEvaluated++;

      const studentData = studentMap[member.heartbeat_id] || {};
      const activityData = activityMap[member.heartbeat_id] || { posts: 0, courseCompletions: [], lastPostDate: null, lastCourseDate: null };
      const prefs = studentData.preferences || {};

      // --- Preference hard overrides ---

      // Student said they're away → skip until they return
      if (prefs.away_until) {
        const awayUntil = new Date(prefs.away_until);
        if (new Date() <= awayUntil) {
          summary.skipped++;
          continue;
        }
      }

      // Student said no morning messages → skip entirely
      if (prefs.no_morning_messages === true) {
        summary.skipped++;
        continue;
      }

      // Student said no weekends → skip on Saturday (6) and Sunday (0)
      if (prefs.no_weekends === true) {
        const romanianNow = new Date(Date.now() + 2 * 3600 * 1000);
        const dayOfWeek = romanianNow.getUTCDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          summary.skipped++;
          continue;
        }
      }

      // Student said always contact them → boost score significantly
      const alwaysBoost = prefs.always_checkin === true ? 100 : 0;

      const score = calculatePriorityScore(member, studentData, activityData) + alwaysBoost;

      if (score > 0) {
        scored.push({
          member,
          studentData,
          activityData,
          hubData: hubMap[studentData.email || member.email] || {},
          prefs,
          score,
          reason: buildReason(member, studentData, activityData, prefs)
        });
      }
    }

    // Sort by priority (highest first), cap at MAX_MESSAGES_PER_RUN
    scored.sort((a, b) => b.score - a.score);
    const toMessage = scored.slice(0, MAX_MESSAGES_PER_RUN);

    console.log(`[Morning] ${scored.length} students flagged, messaging top ${toMessage.length}`);

    // --- Generate and send messages ---
    for (const { member, studentData, activityData, hubData, prefs, reason } of toMessage) {
      try {
        const message = await generateProactiveMessage(member, studentData, activityData, reason, prefs || {}, hubData || {});
        if (!message) {
          summary.skipped++;
          continue;
        }

        await sendSplitMessages(member.heartbeat_id, message);

        // Update last_charlie_proactive timestamp
        await supabase
          .from('students')
          .upsert({
            heartbeat_id: member.heartbeat_id,
            student_id: member.heartbeat_id,
            email: member.email || '',
            name: member.name || '',
            last_charlie_proactive: new Date().toISOString()
          }, { onConflict: 'heartbeat_id' });

        summary.messagesSent++;
        console.log(`[Morning] ✓ Messaged ${member.first_name || member.heartbeat_id} (score: ${scored.find(s => s.member.heartbeat_id === member.heartbeat_id)?.score}) — ${reason}`);

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
 * Calculate priority score (0 = skip, higher = more urgent)
 */
function calculatePriorityScore(member, studentData, activityData = {}) {
  const now = Date.now();

  // --- BLOCK conditions (return 0 immediately) ---

  // If Charlie proactively messaged in the last 3 days → skip
  if (studentData.last_charlie_proactive) {
    const daysSinceProactive = Math.floor(
      (now - new Date(studentData.last_charlie_proactive).getTime()) / (24 * 3600 * 1000)
    );
    if (daysSinceProactive < 3) return 0;
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
  const joinedAt = member.created_at ? new Date(member.created_at) : null;
  const daysSinceJoined = joinedAt
    ? Math.floor((now - joinedAt.getTime()) / (24 * 3600 * 1000))
    : 999;

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
  if (studentData.last_interaction) {
    const daysSinceChat = Math.floor(
      (now - new Date(studentData.last_interaction).getTime()) / (24 * 3600 * 1000)
    );
    if (daysSinceChat >= 14) score += 2; // Long time since any chat
  } else if (daysSinceJoined > 3) {
    score += 1; // Never chatted with Charlie
  }

  // --- Community activity signals ---
  // Active poster → lower priority (they're engaged)
  if (activityData.posts >= 3) score -= 3;
  else if (activityData.posts === 0 && daysSinceJoined > 7) score += 2; // Member but never posted

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
 * Generate a personalised proactive message using OpenAI
 */
async function generateProactiveMessage(member, studentData, activityData = {}, reason, prefs = {}, hubData = {}) {
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

    // ── Extract onboarding profile (Fix 1) ──
    const onboarding = studentData.onboarding_responses || {};
    const charlieProfile = onboarding.charlie || {};
    const tags = charlieProfile.tags || [];
    const primaryDream = charlieProfile.primary_dream || null;
    const biggestBarrier = charlieProfile.biggest_barrier || null;
    const statedHoursPerWeek = onboarding.answers?.hours_per_week || null;
    const hasOnboarding = Object.keys(onboarding).length > 0;

    // ── Fix 3: Milestone detection ──
    const milestones = [];
    if (currentStreak === 7) milestones.push('7-zile-streak');
    if (currentStreak === 30) milestones.push('30-zile-streak');
    if (currentStreak === 100) milestones.push('100-zile-streak');
    if (activityData.courseCompletions?.length >= 1 && activityData.lastCourseDate) {
      const daysSinceFirst = Math.floor((now - new Date(activityData.lastCourseDate).getTime()) / (24 * 3600 * 1000));
      if (daysSinceFirst <= 2 && activityData.courseCompletions.length === 1) milestones.push('primul-curs');
    }
    if (hubData.fluency_vault && !hubData._vault_prev) milestones.push('primul-instrument');

    // ── Fix 2: Dream callback — surface every ~10-14 days ──
    let includeDreamCallback = false;
    if (primaryDream) {
      if (!studentData.last_charlie_proactive) {
        includeDreamCallback = true; // Never messaged — definitely include
      } else {
        const daysSinceProactive = Math.floor(
          (now - new Date(studentData.last_charlie_proactive).getTime()) / (24 * 3600 * 1000)
        );
        if (daysSinceProactive >= 10) includeDreamCallback = true;
      }
    }

    // ── Fix 5: Pattern recognition — stated intentions vs actual behaviour ──
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
      activityData.posts > 0 ? `- Postări în comunitate (ultimele 14 zile): ${activityData.posts}` : '- Nu a postat în comunitate recent',
      activityData.courseCompletions?.length > 0 ? `- Cursuri finalizate recent: ${activityData.courseCompletions.join(', ')}` : null,
      groups.length > 0 ? `- Cursuri/grupuri: ${groups.slice(0, 5).join(', ')}` : null,
      hubData.health_status ? `- Sănătate cont: ${hubData.health_status}` : null,
      hubData.plan ? `- Plan: ${hubData.plan}` : null,
      // Onboarding profile
      hasOnboarding && tags.length > 0 ? `- Profilul studentului [tags]: ${tags.join(', ')}` : null,
      hasOnboarding && primaryDream ? `- Visul/obiectivul declarat: "${primaryDream}"` : null,
      hasOnboarding && biggestBarrier ? `- Bariera principală: ${biggestBarrier}` : null,
      hasOnboarding && charlieProfile.charlie_opening_note ? `- Notă Charlie: ${charlieProfile.charlie_opening_note}` : null,
      // Milestones (Fix 3)
      milestones.length > 0 ? `- ⭐ MILESTONE ATINS: ${milestones.join(', ')}` : null,
      // Pattern notes (Fix 5)
      patternNotes.length > 0 ? `- 🔍 Observație comportamentală: ${patternNotes.join(' | ')}` : null,
      // Dream callback flag (Fix 2)
      includeDreamCallback && primaryDream ? `- 💭 CALLBACK VIS: Leagă natural mesajul de visul lor ("${primaryDream}") — subtil, nu forțat` : null,
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

    const messages = [
      {
        role: 'system',
        content: `Ești Charlie, mentorul personal de engleză la academia Engleza Britanică (pentru vorbitori de română care învață engleza britanică).
Ești cald, empatic, ca un prieten apropiat sau un frate mai mare.
REGULI:
- Vorbești în română (poți folosi câteva cuvinte în engleză dacă e natural)
- NU predai engleza, NU răspunzi la întrebări de gramatică
- Ești un mentor care verifică, încurajează și motivează — nu un profesor
- Mesajele tale sunt scurte și naturale — ca un DM de la un prieten, nu un email
- Poți folosi [SPLIT] pentru a trimite 2-3 mesaje separate (fiecare de 1-2 propoziții) în loc de un bloc de text
- Fii specific și personal, nu generic`
      },
      {
        role: 'user',
        content: `Scrie un mesaj proactiv scurt și personal pentru ${firstName}.

${contextLines}
${suggestionsContext ? '\n' + suggestionsContext : ''}

INSTRUCȚIUNI:
- Maximum 2-3 propoziții (dacă menționezi lecții, pot fi 3-4)
- Nu începe cu "Bună ziua" sau formule formale
- Fii natural și cald — ca un DM de la un prieten apropiat, nu un email corporativ
- Adaptează tonul la situație:
  * NOU (primele 7 zile): entuziasm cald; dacă ai profil onboarding, referință specifică la ce au spus
  * INACTIV (7+ zile): îngrijorare caldă + invitație curioasă, ZERO vinovăție; dacă tag-ul "lapsed" e prezent, ton de "bine că ești înapoi" — nu "de ce ai lipsit"
  * STREAK OPRIT: "viața se întâmplă", revenire fără presiune, un pas mic
  * ⭐ MILESTONE: celebrare specifică și autentică — menționează exact milestone-ul (ex: "7 zile la rând e real!")
- Dacă apare 💭 CALLBACK VIS în context: leagă mesajul de visul/obiectivul lor — subtil, ca o reamintire naturală, nu forțat
- Dacă există 🔍 Observație comportamentală: ține cont în ton (ex: timp limitat → nu pune presiune, lapsed → zero rușine)
- Dacă există sugestii de lecții și studentul e inactiv, menționează 1-2 ca curiozitate ușoară
- Nu fi dramatic sau exagerat
- Semnează scurt: "— Charlie 👋" la final`
      }
    ];

    return await callOpenAI(messages);
  } catch (err) {
    console.error('[generateProactiveMessage] Error:', err.message);
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
