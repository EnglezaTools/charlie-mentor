// /api/onboarding-submit
// Handles survey data from the hosted onboarding survey at /survey
//
// Two actions:
//   sql    — handles the two known INSERT/UPDATE patterns from the survey
//   notify — log/email notification about new submission

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || '',
  { auth: { persistSession: false } }
);

// ── SQL parser helpers ────────────────────────────────────────────────────────
// We receive the exact SQL strings that Results.tsx builds. Rather than
// executing raw SQL (which Supabase REST doesn't support), we recognise the
// two known patterns and use the typed Supabase client.

function parseInsertOnboardingProfiles(sql) {
  // INSERT INTO onboarding_profiles (name, profile) VALUES ('NAME', 'JSON'::jsonb)
  const m = sql.match(/INSERT INTO onboarding_profiles[^)]+\)\s+VALUES\s+\('(.*?)',\s+'([\s\S]*?)'::jsonb\)/i);
  if (!m) return null;
  return { name: m[1], profile: JSON.parse(m[2]) };
}

function parseUpdateStudents(sql) {
  // UPDATE students SET onboarding_responses = 'JSON'::jsonb, first_name = COALESCE(first_name, 'NAME') WHERE LOWER(email) = 'EMAIL'
  const profileMatch = sql.match(/onboarding_responses\s*=\s*'([\s\S]*?)'::jsonb/i);
  const nameMatch = sql.match(/COALESCE\(first_name,\s*'([^']*)'\)/i);
  const emailMatch = sql.match(/LOWER\(email\)\s*=\s*'([^']*)'/i);
  if (!profileMatch || !emailMatch) return null;
  return {
    profile: JSON.parse(profileMatch[1]),
    first_name: nameMatch ? nameMatch[1] : null,
    email: emailMatch[1]
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, query, message } = req.body || {};

  // ── Submit action (primary path — clean JSON, no SQL strings) ─────────────
  if (action === 'submit') {
    const { name, email, profile } = req.body.data || {};
    if (!name || !profile) return res.status(400).json({ error: 'Missing name or profile' });

    // 1. Always insert into onboarding_profiles (history record, never lost)
    const { error: insertError } = await supabase
      .from('onboarding_profiles')
      .insert({ name, profile });
    if (insertError) {
      console.error('[onboarding-submit] Insert onboarding_profiles error:', insertError);
      // Non-fatal — continue to students upsert
    }

    // 2. UPSERT into students — create row if not found, update if found
    if (email && email.trim()) {
      const emailLower = email.trim().toLowerCase();
      const firstName = (name || '').split(' ')[0];

      // Check if student already exists
      const { data: existing } = await supabase
        .from('students')
        .select('id, first_name')
        .ilike('email', emailLower)
        .maybeSingle();

      if (existing) {
        // Update existing student — preserve first_name if already set
        const updateData = { onboarding_responses: profile };
        if (!existing.first_name) updateData.first_name = firstName;
        const { error: updateError } = await supabase
          .from('students')
          .update(updateData)
          .eq('id', existing.id);
        if (updateError) console.error('[onboarding-submit] Update students error:', updateError);
        else console.log(`[onboarding-submit] Updated existing student: ${email}`);
      } else {
        // Insert new student row — survey completion is enough to be in the system
        const { error: newError } = await supabase
          .from('students')
          .insert({
            email: emailLower,
            name,
            first_name: firstName,
            onboarding_responses: profile,
            active: true,
          });
        if (newError) console.error('[onboarding-submit] Insert new student error:', newError);
        else console.log(`[onboarding-submit] Created new student: ${email}`);
      }
    }

    // 3. Notify this agent so Charlie can follow up
    try {
      await fetch('https://webhooks.tasklet.ai/v1/public/webhook?token=a136njyqe1feth4k2vzf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'new_student_onboarding',
          name,
          email,
          tags: profile.charlie?.tags || [],
          charlie_opening_note: profile.charlie?.charlie_opening_note || '',
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (webhookErr) {
      console.error('[onboarding-submit] Agent webhook notify failed:', webhookErr);
      // Non-fatal
    }

    return res.status(200).json({ ok: true });
  }

  // ── SQL action (legacy fallback — kept for safety, should no longer be called) ──
  if (action === 'sql') {
    if (!query) return res.status(400).json({ error: 'Missing query' });

    const normalized = query.trim().toUpperCase();

    // Pattern 1: INSERT INTO onboarding_profiles
    if (normalized.startsWith('INSERT INTO ONBOARDING_PROFILES')) {
      const parsed = parseInsertOnboardingProfiles(query);
      if (!parsed) {
        console.error('[onboarding-submit] Could not parse INSERT query:', query.slice(0, 100));
        return res.status(400).json({ error: 'Could not parse INSERT query' });
      }
      const { error } = await supabase
        .from('onboarding_profiles')
        .insert({ name: parsed.name, profile: parsed.profile });
      if (error) {
        console.error('[onboarding-submit] Supabase insert error:', error);
        return res.status(500).json({ error: error.message });
      }
      return res.status(200).json({ ok: true });
    }

    // Pattern 2: UPDATE students
    if (normalized.startsWith('UPDATE STUDENTS')) {
      const parsed = parseUpdateStudents(query);
      if (!parsed) {
        console.error('[onboarding-submit] Could not parse UPDATE query:', query.slice(0, 100));
        return res.status(400).json({ error: 'Could not parse UPDATE query' });
      }
      const updateData = { onboarding_responses: parsed.profile };
      if (parsed.first_name) updateData.first_name = parsed.first_name;
      const { error } = await supabase
        .from('students')
        .update(updateData)
        .ilike('email', parsed.email);
      if (error) {
        console.error('[onboarding-submit] Supabase update error:', error);
        return res.status(500).json({ error: error.message });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(403).json({ error: 'Unrecognised query pattern' });
  }

  // ── Notify action ──────────────────────────────────────────────────────────
  if (action === 'notify') {
    // Log to Vercel function logs (visible in dashboard)
    console.log('[onboarding-submit] New submission:', message);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
};
