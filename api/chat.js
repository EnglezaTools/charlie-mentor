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
      // Build a personalised greeting if we have onboarding data
      const ob = student.onboarding_responses || {};
      const hasOnboarding = ob.answers && (ob.answers.dream_scenario || ob.answers.biggest_challenges?.length);
      const firstName = student.first_name || ob.answers?.name || 'student';

      let greetingContent;
      if (hasOnboarding) {
        const dream = ob.answers.dream_scenario || '';
        const challenges = (ob.answers.biggest_challenges || []).join(', ');
        const selfConscious = ob.answers.most_self_conscious || '';
        const goals = (ob.answers.why_english || []).join(', ');
        const level = ob.recommendation?.level || '';
        const location = ob.answers.location || '';
        const inUK = location && (location.toLowerCase().includes('uk') || location.toLowerCase().includes('londra') || location.toLowerCase().includes('manchester') || location.toLowerCase().includes('birmingham') || ob.answers.years_in_uk);

        greetingContent = `[Studentul ${firstName} tocmai s-a conectat la chat.

Ai aceste informații din chestionarul lor de onboarding:
- Visul/scopul lor: "${dream}"
- De ce studiază engleza: ${goals}
- Provocările principale: ${challenges}
- Ce îi face să se simtă nesiguri: ${selfConscious}
- Nivelul lor evaluat: ${level}
${inUK ? `- Locuiesc în UK (${location})` : `- Locație: ${location}`}

Salută-l PERSONAL și SPECIFIC — alege UN singur element din visul sau provocările lor care rezonează cel mai mult și menționează-l natural, ca și cum știai deja cine sunt. 
NU lista toate informațiile. NU fii generic ("bun venit!", "cum merge?"). 
Fă-i să simtă că sunt VĂZUȚI — că cineva știe DE CE sunt aici.
Fii cald, scurt (2-3 propoziții), și lasă ușa deschisă pentru conversație.]`;
      } else {
        greetingContent = `[Studentul tocmai s-a conectat la chat. Salută-l pe ${firstName} cu căldură, întreabă cum se simte și cum merge cu învățarea. Fii scurt și prietenos — max 2-3 propoziții.]`;
      }

      messages.push({
        role: 'user',
        content: greetingContent
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
