const { getAllMembers, sendDirectMessage } = require('./_lib/heartbeat');
const { callOpenAI } = require('./_lib/charlie');
const { supabase } = require('./_lib/supabase');

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

    // --- Get student records from Supabase ---
    const { data: studentRecords } = await supabase
      .from('students')
      .select('heartbeat_id, current_streak, longest_streak, last_login_date, last_charlie_proactive, last_interaction');

    const studentMap = {};
    if (studentRecords) {
      for (const s of studentRecords) {
        studentMap[s.heartbeat_id] = s;
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

      summary.studentsEvaluated++;

      const studentData = studentMap[member.heartbeat_id] || {};
      const activityData = activityMap[member.heartbeat_id] || { posts: 0, courseCompletions: [], lastPostDate: null, lastCourseDate: null };
      const score = calculatePriorityScore(member, studentData, activityData);

      if (score > 0) {
        scored.push({
          member,
          studentData,
          activityData,
          score,
          reason: buildReason(member, studentData, activityData)
        });
      }
    }

    // Sort by priority (highest first), cap at MAX_MESSAGES_PER_RUN
    scored.sort((a, b) => b.score - a.score);
    const toMessage = scored.slice(0, MAX_MESSAGES_PER_RUN);

    console.log(`[Morning] ${scored.length} students flagged, messaging top ${toMessage.length}`);

    // --- Generate and send messages ---
    for (const { member, studentData, activityData, reason } of toMessage) {
      try {
        const message = await generateProactiveMessage(member, studentData, activityData, reason);
        if (!message) {
          summary.skipped++;
          continue;
        }

        await sendDirectMessage(member.heartbeat_id, message);

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
function buildReason(member, studentData, activityData = {}) {
  const reasons = [];
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
async function generateProactiveMessage(member, studentData, activityData = {}, reason) {
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

    // Extract onboarding context
    const onboarding = member.onboarding_responses || {};
    const onboardingText = Object.keys(onboarding).length > 0
      ? Object.entries(onboarding).map(([k, v]) => `${k}: ${v}`).join('; ')
      : null;

    const contextLines = [
      daysSinceJoined !== null ? `- Zile de la înregistrare: ${daysSinceJoined}` : null,
      currentStreak > 0 ? `- Streak curent: ${currentStreak} zile consecutive` : null,
      daysSinceLogin !== null ? `- Ultima autentificare: acum ${daysSinceLogin} zile` : '- Nu s-a autentificat recent',
      activityData.posts > 0 ? `- Postări în comunitate (ultimele 14 zile): ${activityData.posts}` : '- Nu a postat în comunitate recent',
      activityData.courseCompletions?.length > 0 ? `- Cursuri finalizate recent: ${activityData.courseCompletions.join(', ')}` : null,
      groups.length > 0 ? `- Cursuri/grupuri: ${groups.slice(0, 5).join(', ')}` : null,
      onboardingText ? `- Context înregistrare: ${onboardingText}` : null,
      `- Motiv check-in: ${reason}`
    ].filter(Boolean).join('\n');

    const messages = [
      {
        role: 'system',
        content: `Ești Charlie, mentorul personal de engleză la academia Engleza Britanică (pentru vorbitori de română care învață engleza britanică).
Ești cald, empatic, ca un prieten apropiat sau un frate mai mare.
REGULI:
- Vorbești în română (poți folosi câteva cuvinte în engleză dacă e natural)
- NU predai engleza, NU răspunzi la întrebări de gramatică
- Ești un mentor care verifică, încurajează și motivează — nu un profesor
- Mesajele tale sunt scurte: 2-3 propoziții MAXIM
- Fii specific și personal, nu generic`
      },
      {
        role: 'user',
        content: `Scrie un mesaj proactiv scurt și personal pentru ${firstName}.

${contextLines}

INSTRUCȚIUNI:
- Maximum 2-3 propoziții
- Nu începe cu "Bună ziua" sau formule formale
- Fii natural și cald, ca și cum ai scrie unui prieten
- Adaptează tonul la situație (nou = entuziasm, inactiv = îngrijorare caldă, streak oprit = încurajare)
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
