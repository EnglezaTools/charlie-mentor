/**
 * suggestions.js
 * Picks 2 interesting lesson suggestions for unengaged students.
 * One from near the student's level, one as a surprise from elsewhere.
 */

const { supabase } = require('./supabase');

/**
 * Detect approximate week range from Heartbeat group names.
 * Returns { min, max } for the student's likely current level.
 */
function detectApproxWeekRange(groups = []) {
  const gl = groups.map(g => (typeof g === 'string' ? g : g.name || '')).join(' ').toLowerCase();

  if (gl.includes('engleza reala') || gl.includes('engleza reală') || gl.includes('p4')) {
    return { min: 40, max: 51 };
  }
  if (gl.includes('idei legate') || gl.includes('p3') || gl.includes('vorbirea legata') || gl.includes('vorbirea legată')) {
    return { min: 27, max: 39 };
  }
  if (gl.includes('exprimare') || gl.includes('clara') || gl.includes('clară') || gl.includes('p2')) {
    return { min: 14, max: 26 };
  }
  // Default: Baza Solidă (most students)
  return { min: 1, max: 13 };
}

/**
 * Pick a random item from an array.
 */
function randomPick(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Extract the single most compelling learning point from a lesson.
 */
function getKeyPoint(lesson) {
  const pts = (lesson.learning_points || []);
  for (const p of pts) {
    const text = typeof p === 'string' ? p : (p.point || '');
    if (text && text.length > 10) return text;
  }
  return null;
}

/**
 * Pick 2 suggested lessons for a student:
 *   [0] = from their approximate level (relevant)
 *   [1] = from a different range (surprise/discovery)
 *
 * @param {string[]} memberGroups - array of group name strings or group objects
 * @returns {Array<{lesson_name, lesson_url, week, key_point}>}
 */
async function pickSuggestedLessons(memberGroups = []) {
  try {
    // Only use Grammar lessons — they're the well-populated type
    const { data: lessons, error } = await supabase
      .from('lesson_index')
      .select('lesson_id, lesson_name, lesson_url, week, type, learning_points')
      .eq('type', 'Grammar')
      .not('lesson_url', 'is', null)
      .not('lesson_name', 'is', null);

    if (error || !lessons || lessons.length === 0) {
      console.warn('[suggestions] Could not fetch lesson_index:', error?.message);
      return [];
    }

    const range = detectApproxWeekRange(memberGroups);

    const inRange = lessons.filter(l => l.week >= range.min && l.week <= range.max);
    const outOfRange = lessons.filter(l => l.week < range.min || l.week > range.max);

    const pick1 = randomPick(inRange) || randomPick(lessons);
    const pick2 = randomPick(outOfRange.filter(l => l.lesson_id !== pick1?.lesson_id)) || randomPick(lessons.filter(l => l.lesson_id !== pick1?.lesson_id));

    const result = [];
    for (const pick of [pick1, pick2]) {
      if (!pick) continue;
      result.push({
        lesson_name: pick.lesson_name,
        lesson_url: pick.lesson_url,
        week: pick.week,
        key_point: getKeyPoint(pick)
      });
    }

    return result;
  } catch (err) {
    console.warn('[suggestions] Error picking lessons:', err.message);
    return [];
  }
}

/**
 * Format suggestions as a context block for Charlie's prompt.
 * tone: 'proactive' (morning check-in) or 'reactive' (student messaged after absence)
 */
function formatSuggestionsContext(suggestions, tone = 'proactive') {
  if (!suggestions || suggestions.length === 0) return '';

  const lines = suggestions.map(s => {
    const link = s.lesson_url ? `<a href="${s.lesson_url}">${s.lesson_name}</a>` : s.lesson_name;
    const point = s.key_point ? ` — "${s.key_point}"` : '';
    const loc = s.week ? ` (Week ${s.week})` : '';
    return `  • ${link}${loc}${point}`;
  }).join('\n');

  if (tone === 'proactive') {
    return `SUGESTII TEMATICE PENTRU STUDENT INACTIV:
Studentul nu a mai fost activ de ceva timp. Poți menționa cu blândețe 1-2 subiecte interesante din academie ca o invitație curioasă — nu ca obligație sau temă. Prezintă-le ca opțiuni: "mi-ar plăcea să îți arăt X sau Y — spune-mi dacă ești curios/ă".
Dacă le menționezi, folosește link-ul exact din lista de mai jos. Nu inventa alte lecții sau URL-uri.
Lecții sugerate:
${lines}`;
  } else {
    // reactive — student has come back after absence
    return `SUGESTII PENTRU RELUAREA ACTIVITĂȚII:
Studentul tocmai a revenit după o perioadă de inactivitate. Dacă simți că e momentul potrivit în conversație, poți menţiona ușor 1-2 lecții care ar putea fi un punct bun de reluare. Nu insista — oferă, nu împinge.
Dacă le menționezi, folosește link-ul exact. Nu inventa lecții sau URL-uri.
Lecții sugerate:
${lines}`;
  }
}

module.exports = { pickSuggestedLessons, formatSuggestionsContext, detectApproxWeekRange };
