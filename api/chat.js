const { supabase } = require('./_lib/supabase');
const { buildSystemPrompt } = require('./_lib/charlie');
const OpenAI = require('openai');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
    const { token, message } = req.body || {};

    if (!token || !message) {
      return res.status(400).json({ detail: 'Token și mesaj sunt obligatorii.' });
    }

    // Look up student by token
    const { data: student, error: studentErr } = await supabase
      .from('students')
      .select('*')
      .eq('token', token)
      .single();

    if (studentErr || !student) {
      return res.status(401).json({ detail: 'Token invalid. Te rugăm să te autentifici din nou.' });
    }

    // Update last_seen
    await supabase
      .from('students')
      .update({ last_seen: new Date().toISOString() })
      .eq('id', student.id);

    // Determine if this is a greeting
    const isGreeting = message === '__GREETING__';

    // Get last 20 messages for context
    const { data: history } = await supabase
      .from('conversations')
      .select('role, content')
      .eq('student_id', student.id)
      .order('id', { ascending: false })
      .limit(20);

    const pastMessages = (history || []).reverse().map(m => ({
      role: m.role,
      content: m.content
    }));

    // Build system prompt
    const systemPrompt = await buildSystemPrompt(student);

    // Build messages array for OpenAI
    const messages = [
      { role: 'system', content: systemPrompt },
      ...pastMessages
    ];

    if (isGreeting) {
      messages.push({
        role: 'user',
        content: `[Studentul tocmai s-a conectat la chat. Salută-l pe ${student.first_name || 'student'} cu căldură, întreabă cum se simte și cum merge cu învățarea. Fii scurt și prietenos — max 2-3 propoziții.]`
      });
    } else {
      messages.push({
        role: 'user',
        content: message
      });
    }

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      temperature: 0.8,
      max_tokens: 500
    });

    const reply = completion.choices[0]?.message?.content || 'Hmm, nu am reușit să generez un răspuns. Încearcă din nou!';

    // Save messages to conversations (skip saving the __GREETING__ trigger)
    if (!isGreeting) {
      await supabase.from('conversations').insert({
        student_id: student.id,
        role: 'user',
        content: message
      });
    }

    await supabase.from('conversations').insert({
      student_id: student.id,
      role: 'assistant',
      content: reply
    });

    return res.status(200).json({ reply });

  } catch (err) {
    console.error('[Chat] Error:', err);
    return res.status(500).json({ detail: 'Eroare la generarea răspunsului. Încearcă din nou.' });
  }
};
