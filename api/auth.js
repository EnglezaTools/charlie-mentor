const { supabase } = require('./_lib/supabase');
const { findUser } = require('./_lib/heartbeat');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).set(CORS_HEADERS).end();
  }

  // Set CORS headers
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'POST') {
    return res.status(405).json({ detail: 'Method not allowed' });
  }

  try {
    const { email } = req.body || {};

    if (!email || !email.includes('@')) {
      return res.status(400).json({ detail: 'Te rugăm să introduci o adresă de email validă.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Look up user in Heartbeat
    const hbUser = await findUser(normalizedEmail);

    if (!hbUser) {
      return res.status(200).json({
        found: false,
        message: 'Emailul nu a fost găsit în comunitatea Engleza Britanică. Verifică emailul sau contactează echipa de suport.'
      });
    }

    // Upsert student into database
    const { data: existing } = await supabase
      .from('students')
      .select('id, token, name')
      .eq('email', normalizedEmail)
      .single();

    let studentToken, studentName;

    if (existing) {
      // Update existing student
      const { data: updated } = await supabase
        .from('students')
        .update({
          heartbeat_id: hbUser.heartbeat_id,
          name: hbUser.name,
          first_name: hbUser.first_name,
          bio: hbUser.bio,
          groups: Array.isArray(hbUser.groups) ? hbUser.groups : [],
          onboarding_responses: hbUser.onboarding_responses || {},
          last_seen: new Date().toISOString()
        })
        .eq('id', existing.id)
        .select('token, name, first_name')
        .single();

      studentToken = updated?.token || existing.token;
      studentName = updated?.first_name || updated?.name || hbUser.first_name || hbUser.name;
    } else {
      // Insert new student
      const { data: created } = await supabase
        .from('students')
        .insert({
          email: normalizedEmail,
          heartbeat_id: hbUser.heartbeat_id,
          name: hbUser.name,
          first_name: hbUser.first_name,
          bio: hbUser.bio,
          groups: Array.isArray(hbUser.groups) ? hbUser.groups : [],
          onboarding_responses: hbUser.onboarding_responses || {}
        })
        .select('token, name, first_name')
        .single();

      studentToken = created?.token;
      studentName = created?.first_name || created?.name || hbUser.first_name || hbUser.name;
    }

    return res.status(200).json({
      found: true,
      token: studentToken,
      name: studentName
    });

  } catch (err) {
    console.error('[Auth] Error:', err);
    return res.status(500).json({ detail: 'Eroare internă de server. Încearcă din nou.' });
  }
};
