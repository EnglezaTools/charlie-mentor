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

    // Ensure groups is a simple string array (Heartbeat may return objects)
    let groupNames = [];
    if (Array.isArray(hbUser.groups)) {
      groupNames = hbUser.groups.map(g => typeof g === 'string' ? g : (g.name || g.id || String(g)));
    }

    // Check if student already exists
    const { data: existing, error: lookupErr } = await supabase
      .from('students')
      .select('id, token, name')
      .eq('email', normalizedEmail)
      .single();

    if (lookupErr) {
      console.log('[Auth] Lookup result (not an error if no rows):', lookupErr.code);
    }

    let studentToken, studentName;

    if (existing && existing.id) {
      // Update existing student
      const { data: updated, error: updateErr } = await supabase
        .from('students')
        .update({
          heartbeat_id: hbUser.heartbeat_id || null,
          name: hbUser.name || null,
          first_name: hbUser.first_name || null,
          bio: hbUser.bio || null,
          groups: groupNames,
          onboarding_responses: hbUser.onboarding_responses || {},
          last_seen: new Date().toISOString()
        })
        .eq('id', existing.id)
        .select('token, name, first_name')
        .single();

      if (updateErr) {
        console.error('[Auth] Update error:', updateErr);
      }

      studentToken = updated?.token || existing.token;
      studentName = updated?.first_name || updated?.name || existing.name || hbUser.first_name || hbUser.name;
    } else {
      // Insert new student
      const { data: created, error: insertErr } = await supabase
        .from('students')
        .insert({
          email: normalizedEmail,
          heartbeat_id: hbUser.heartbeat_id || null,
          name: hbUser.name || null,
          first_name: hbUser.first_name || null,
          bio: hbUser.bio || null,
          groups: groupNames,
          onboarding_responses: hbUser.onboarding_responses || {}
        })
        .select('token, name, first_name')
        .single();

      if (insertErr) {
        console.error('[Auth] Insert error:', insertErr);
        return res.status(500).json({ detail: 'Eroare la crearea contului: ' + insertErr.message });
      }

      studentToken = created?.token;
      studentName = created?.first_name || created?.name || hbUser.first_name || hbUser.name;
    }

    if (!studentToken) {
      console.error('[Auth] No token generated for:', normalizedEmail);
      return res.status(500).json({ detail: 'Nu s-a putut genera un token. Contactează suportul.' });
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
