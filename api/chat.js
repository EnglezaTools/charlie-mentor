const { supabase } = require('./_lib/supabase');
const { buildSystemPrompt, callOpenAI } = require('./_lib/charlie');

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

    // Update last_seen + FIX 1: Reset unanswered counter when student engages
    await supabase
      .from('students')
      .update({
        last_seen: new Date().toISOString(),
        last_interaction: new Date().toISOString(),
        charlie_unanswered_count: 0  // Student responded — reset the cap
      })
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
        // Use the pre-digested Charlie profile if available (enriched format)
        const cp = ob.charlie;
        let contextNote;
        if (cp && cp.charlie_opening_note) {
          contextNote = `Context despre student: ${cp.charlie_opening_note}`;
        } else {
          // Fall back to raw fields for older profiles
          const dream = ob.answers.dream_scenario || '';
          const challenges = (ob.answers.biggest_challenges || []).join(', ');
          const selfConscious = ob.answers.most_self_conscious || '';
          const goals = (ob.answers.why_english || []).join(', ');
          const level = ob.recommendation?.level || '';
          const location = ob.answers.location || '';
          const inUK = location && (location.toLowerCase().includes('uk') || location.toLowerCase().includes('londra') || location.toLowerCase().includes('manchester') || location.toLowerCase().includes('birmingham') || ob.answers.years_in_uk);
          contextNote = `Informații din chestionarul de onboarding:\n- Visul lor: "${dream}"\n- De ce studiază: ${goals}\n- Provocări: ${challenges}\n- Nesiguranță: ${selfConscious}\n- Nivel: ${level}\n${inUK ? `- UK (${location})` : `- Locație: ${location}`}`;
        }

        // Tag-based hints — multiple tags can apply simultaneously
        const tags = cp?.tags || [];
        const hintParts = [];
        if (tags.includes('se-blochează')) hintParts.push('Se blochează când vorbește — fii cald, nu pune presiune pe producție.');
        if (tags.includes('lapsed')) hintParts.push('A mai abandonat înainte — zero vinovăție, nicio referire la pauze ca eșec.');
        if (tags.includes('time-short')) hintParts.push('Timp foarte limitat — fii scurt, oferă UN singur pas concret.');
        if (tags.includes('perfectionist')) hintParts.push('Tinde spre perfecționism — normalizează greșelile explicit.');
        if (tags.includes('visător')) hintParts.push('Are un vis clar — leagă orice feedback de visul lor când e natural.');
        const personalityHint = hintParts.length ? '\n' + hintParts.join(' ') : '';

        greetingContent = `[Studentul ${firstName} tocmai s-a conectat la chat pentru prima dată.

${contextNote}${personalityHint}

Salută-l PERSONAL și SPECIFIC — alege UN singur element din visul sau provocările lor și menționează-l natural, ca și cum știai deja cine sunt. 
NU lista toate informațiile. NU fii generic. 
Fă-i să simtă că sunt VĂZUȚI — că cineva știe DE CE sunt aici.
Fii cald, scurt (2-3 propoziții), lasă ușa deschisă pentru conversație.]`;
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

    // Detect first real interaction (no prior student messages in history)
    const isFirstRealMessage = !isGreeting && pastMessages.filter(m => m.role === 'user').length === 0;

    // Call Claude via callOpenAI wrapper
    let reply = await callOpenAI(messages, { max_tokens: 500, temperature: 0.8 }) || 'Hmm, nu am reușit să generez un răspuns. Încearcă din nou!';

    // Append monitoring disclosure on first real interaction
    if (isFirstRealMessage) {
      reply += '\n\n---\n_Notă: Conversațiile din acest chat pot fi revizuite de echipa academiei în scopuri de control al calității și îmbunătățire a serviciului._';
    }

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
