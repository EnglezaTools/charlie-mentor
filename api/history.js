const { supabase } = require('./_lib/supabase');

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

  if (req.method !== 'GET') {
    return res.status(405).json({ detail: 'Method not allowed' });
  }

  try {
    const token = req.query.token;

    if (!token) {
      return res.status(400).json({ detail: 'Token is required.' });
    }

    // Look up student
    const { data: student, error: studentErr } = await supabase
      .from('students')
      .select('id, first_name, name')
      .eq('token', token)
      .single();

    if (studentErr || !student) {
      return res.status(401).json({ detail: 'Token invalid.' });
    }

    // Get last 10 messages
    const { data: messages } = await supabase
      .from('conversations')
      .select('role, content, created_at')
      .eq('student_id', student.id)
      .order('id', { ascending: false })
      .limit(10);

    const sorted = (messages || []).reverse();

    return res.status(200).json({
      messages: sorted.map(m => ({
        role: m.role,
        content: m.content
      })),
      first_name: student.first_name || student.name || null
    });

  } catch (err) {
    console.error('[History] Error:', err);
    return res.status(500).json({ detail: 'Eroare la încărcarea istoricului.' });
  }
};
