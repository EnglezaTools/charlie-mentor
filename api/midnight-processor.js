const { getAllMembers } = require('./_lib/heartbeat');
const { supabase } = require('./_lib/supabase');

const CHARLIE_USER_ID = '4123ccdd-a337-4438-b5ff-fcaad1464102';

/**
 * POST /api/midnight-processor
 * Called at 00:01 Romanian time (22:01 UTC) by Tasklet schedule trigger.
 *
 * 1. Fetch all community members from Heartbeat
 * 2. Record today's logins (anyone with "Active" or "Log-in" group)
 * 3. Calculate streaks for all tracked students
 * 4. Update students table with streak data
 * 5. Return summary
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();
  const summary = {
    loginsRecorded: 0,
    streaksUpdated: 0,
    errors: [],
    loginDate: null
  };

  try {
    // Determine "today" in Romanian time (UTC+2).
    // This runs at 00:01 EET, so Romanian "yesterday" is the day we're closing out.
    const romanianNow = new Date(Date.now() + 2 * 3600 * 1000);
    // Subtract 1 day: at 00:01 on day N, we're closing out day N-1
    const yesterday = new Date(romanianNow);
    yesterday.setDate(yesterday.getDate() - 1);
    const loginDate = yesterday.toISOString().split('T')[0]; // YYYY-MM-DD
    summary.loginDate = loginDate;

    console.log(`[Midnight] Processing login snapshot for ${loginDate}`);

    // --- STEP 1: Fetch all members and record logins ---
    const members = await getAllMembers();
    console.log(`[Midnight] Processing ${members.length} members`);

    const loginUpserts = [];

    for (const member of members) {
      // Skip Charlie's own account and admins
      if (member.heartbeat_id === CHARLIE_USER_ID) continue;
      if (member.is_admin) continue;
      if (!member.heartbeat_id) continue;

      const groups = member.groups || [];
      const groupStr = groups.join(' ').toLowerCase();
      const isActive = groupStr.includes('active') || groupStr.includes('log-in') || groupStr.includes('login');

      if (isActive) {
        loginUpserts.push({
          user_id: member.heartbeat_id,
          login_date: loginDate,
          recorded_at: new Date().toISOString()
        });
      }
    }

    // Batch upsert logins (in chunks of 50)
    for (let i = 0; i < loginUpserts.length; i += 50) {
      const chunk = loginUpserts.slice(i, i + 50);
      const { error } = await supabase
        .from('daily_logins')
        .upsert(chunk, { onConflict: 'user_id,login_date' });
      if (error) {
        summary.errors.push(`Login upsert chunk ${i}: ${error.message}`);
      } else {
        summary.loginsRecorded += chunk.length;
      }
    }

    console.log(`[Midnight] Recorded ${summary.loginsRecorded} logins for ${loginDate}`);

    // --- STEP 2: Calculate streaks for all students ---
    // Get all unique user IDs that have any login history
    const { data: allLoginUsers, error: loginUsersErr } = await supabase
      .from('daily_logins')
      .select('user_id')
      .order('user_id');

    if (loginUsersErr) {
      summary.errors.push(`Fetching login users: ${loginUsersErr.message}`);
    } else {
      // Deduplicate user IDs
      const uniqueUserIds = [...new Set(allLoginUsers.map(r => r.user_id))];
      console.log(`[Midnight] Calculating streaks for ${uniqueUserIds.length} users`);

      for (const userId of uniqueUserIds) {
        try {
          const streak = await calculateStreak(userId, loginDate);

          // Upsert streak data to students table
          const { error: streakErr } = await supabase
            .from('students')
            .upsert({
              heartbeat_id: userId,
              student_id: userId,
              current_streak: streak.current,
              longest_streak: streak.longest,
              last_login_date: streak.lastLoginDate
            }, { onConflict: 'heartbeat_id' });

          if (streakErr) {
            summary.errors.push(`Streak update ${userId}: ${streakErr.message}`);
          } else {
            summary.streaksUpdated++;
          }
        } catch (err) {
          summary.errors.push(`Streak calc ${userId}: ${err.message}`);
        }
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[Midnight] Complete in ${elapsed}s:`, summary);

    return res.status(200).json({
      success: true,
      elapsed_seconds: elapsed,
      ...summary
    });
  } catch (err) {
    console.error('[Midnight] Fatal error:', err.message);
    return res.status(500).json({ error: err.message, summary });
  }
};

/**
 * Calculate current and longest streak for a user
 * @param {string} userId
 * @param {string} referenceDate - YYYY-MM-DD, the most recent completed day
 */
async function calculateStreak(userId, referenceDate) {
  const { data: logins, error } = await supabase
    .from('daily_logins')
    .select('login_date')
    .eq('user_id', userId)
    .order('login_date', { ascending: false })
    .limit(365);

  if (error || !logins || logins.length === 0) {
    return { current: 0, longest: 0, lastLoginDate: null };
  }

  const loginSet = new Set(logins.map(l => l.login_date));
  const lastLoginDate = logins[0].login_date;

  // Calculate current streak (consecutive days ending on referenceDate)
  let currentStreak = 0;
  const ref = new Date(referenceDate);
  for (let i = 0; i < 365; i++) {
    const checkDate = new Date(ref);
    checkDate.setDate(checkDate.getDate() - i);
    const dateStr = checkDate.toISOString().split('T')[0];
    if (loginSet.has(dateStr)) {
      currentStreak++;
    } else {
      break;
    }
  }

  // Calculate longest streak from all history
  const sortedDates = [...loginSet].sort();
  let longestStreak = 0;
  let tempStreak = 1;
  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(sortedDates[i - 1]);
    const curr = new Date(sortedDates[i]);
    const diffDays = Math.round((curr - prev) / (24 * 3600 * 1000));
    if (diffDays === 1) {
      tempStreak++;
      longestStreak = Math.max(longestStreak, tempStreak);
    } else {
      tempStreak = 1;
    }
  }
  longestStreak = Math.max(longestStreak, tempStreak, currentStreak);

  return { current: currentStreak, longest: longestStreak, lastLoginDate };
}
