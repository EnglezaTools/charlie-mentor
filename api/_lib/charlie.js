const { supabase } = require('./supabase');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Call OpenAI with a messages array
 * @param {Array} messages - The messages array
 * @param {Object} opts - Optional overrides: { model, max_tokens, temperature, response_format }
 */
async function callOpenAI(messages, opts = {}) {
  const model = opts.model || 'gpt-4o-mini';
  const completion = await openai.chat.completions.create({
    model,
    messages,
    max_tokens: opts.max_tokens || 500,
    temperature: opts.temperature !== undefined ? opts.temperature : 0.8,
    ...(opts.response_format ? { response_format: opts.response_format } : {})
  });
  return completion.choices[0].message.content;
}

// Static course summary built from community_structure data
const STATIC_COURSE_SUMMARY = `
📚 Baza Solidă (Săptămânile 1-13, 3 luni):
  Programul de bază pentru începători. Acoperă fundamentele limbii engleze.
  • Month 1 (Weeks 1-4): Introducere, Pronunție, Prezent Simplu, TO BE, Verbe auxiliare, Întrebări și negații
  • Month 2 (Weeks 5-8): Substantive și Articole, Adjective, Pronume, Posesiv, Prepoziții (At/To, In/On/At)
  • Month 3 (Weeks 9-12): Adverbe, Propozitii (Imperativ, Declaratii), Conjuncții, Timpul Progresiv
  Fiecare săptămână include: Pronunție, 2 lecții de Gramatică, 2 liste de Vocabular, Exersare, Temă, Recapitulare PDF, Quiz, Audio

📚 Exprimare Clară (Săptămânile 14-26, 3 luni):
  Nivel intermediar. Dezvoltă capacitatea de exprimare.
  • Month 1 (Weeks 14-17): Alfabetul, Spelling, Numere, Timpul Viitor
  • Month 2 (Weeks 18-21): Adjective comparative/superlative, Obligații, Timpul trecut
  • Month 3 (Weeks 22-25): Timpul trecut avansat, Verbe modale, Întrebări deschise

📚 Idei Legate (Săptămânile 27-39, 3 luni):
  Nivel intermediar-avansat. Conectarea ideilor complexe.
  • Month 1 (Weeks 27-30): Conditionals, Dummy Subjects, Indefinite Pronouns, Linking Verbs
  • Month 2 (Weeks 31-34): Gerunds & Infinitives, Adjective (-ed/-ing)
  • Month 3 (Weeks 35-38): Adverbe de timp, Propoziții complexe, Relative pronouns

📚 Engleză Reală (Săptămânile 40-51, 3 luni):
  Nivel avansat. Engleza autentică și naturală.
  • Month 1 (Weeks 40-43): Compound Nouns/Adjectives, Phrasal Verbs, Collocations, Past Progressive
  • Month 2 (Weeks 44-47): Modal Verbs (Past), Conditional 2nd/3rd, Delexical Verbs, Used to
  • Month 3 (Weeks 48-51): Talking about time, Passive Voice, Articles advanced, Stranded Prepositions, 12 timpuri verbale

📚 Vocabular (8 Module + extra):
  Colecții separate de vocabular, Lists 1-96+, organizate în module de câte 4 colecții

📚 Engleza Britanică din Mers:
  Curs în clasă, 2 module (24 săptămâni de lecții)

📚 Transformă-ți Engleza în 2025!:
  Curs introductiv gratuit cu 15 strategii de învățare, prezentat de Alasdair Jones

📚 Cursuri suplimentare:
  • Pronunție Perfectă — 48 lecții de pronunție
  • Propoziții simple — construirea propozițiilor
  • Baza esențială P1 & P2 — fundamente esențiale
  • Timpul viitor / Timpul trecut & adjective comparative
  • Verbe modale & timpul trecut
  • Structuri gramaticale esențiale
  • Construcții cu Infinitiv și Gerunziu
  • Propoziții complexe
  • Unități lexicale compuse și expresii
  • Construcții avansate / Expresii și structuri esențiale
  • Collocations, Phrasal Verbs, Advanced Grammar, Idioms
  • Speech Analysis, Text Analysis
  • Module de pronunție: Sunete de vocale, Sunete de consoane, Vorbirea legată, Exersare
  • Primii pași în Engleza Britanică Academy — ghid de start`.trim();

const STATIC_CHANNEL_LIST = `
  🗣️ Temele - Pronunție — postează temele de pronunție
  📅 Engleza Zilnică — exerciții zilnice
  🧵 Bine ați venit — mesaje de bun venit
  🤝 Ajutor Suplimentar — ajutor extra de la echipă
  ❓ Întrebări și Răspunsuri — pune întrebări despre engleză
  🏆 Progrese și Succese — celebrează realizările
  🔗 Nivel 3 - Structura Integrată — conținut nivel 3
  📣 PROVOCARE - Sunetele Britanice — provocări de pronunție
  ❓ Întrebări — întrebări generale
  🕙 Nivel 2 - Timpuri Explicate — conținut nivel 2
  🎓 General - RO — discuții generale în română
  📝 Temele - UK — teme în engleză
  🎓 Anunțuri și Info — anunțuri oficiale
  😉 Jokes and Teasers — glume și provocări
  👋 Bine ai venit — canal de bun venit
  📝 Temele - RO — teme în română
  🎓 General - UK — discuții generale în engleză
  📝 Temele - Gramatică — teme de gramatică`.trim();

/**
 * Build course summary — tries Supabase cache first, falls back to static
 */
async function buildCoursesSummary() {
  try {
    const { data: cache } = await supabase
      .from('community_cache')
      .select('value')
      .eq('key', 'courses')
      .single();

    if (cache && cache.value && Array.isArray(cache.value) && cache.value.length > 0) {
      // Build dynamic summary from cached courses
      const courses = cache.value;
      const lines = [`Total cursuri: ${courses.length}`];
      for (const c of courses.slice(0, 30)) {
        const name = c.name || c.title || 'Unnamed';
        lines.push(`  • ${name}`);
      }
      if (courses.length > 30) {
        lines.push(`  ... și alte ${courses.length - 30} cursuri`);
      }
      return lines.join('\n');
    }
  } catch (err) {
    // Fallback to static
  }

  return STATIC_COURSE_SUMMARY;
}

/**
 * Build channel list — tries Supabase cache first, falls back to static
 */
async function buildChannelList() {
  try {
    const { data: cache } = await supabase
      .from('community_cache')
      .select('value')
      .eq('key', 'channels')
      .single();

    if (cache && cache.value && Array.isArray(cache.value) && cache.value.length > 0) {
      const channels = cache.value;
      return channels.map(ch => {
        const emoji = ch.emoji || '';
        const name = ch.name || ch.title || '';
        return `  ${emoji} ${name}`;
      }).join('\n');
    }
  } catch (err) {
    // Fallback to static
  }

  return STATIC_CHANNEL_LIST;
}

/**
 * Search transcripts by keyword
 */
async function searchTranscripts(keyword, limit = 3) {
  try {
    const { data, error } = await supabase
      .from('transcripts')
      .select('title, type, week, lesson_number, part, content')
      .or(`content.ilike.%${keyword}%,title.ilike.%${keyword}%`)
      .limit(limit);

    if (error || !data || data.length === 0) return null;

    return data.map(t => ({
      title: t.title,
      type: t.type,
      week: t.week,
      lesson_number: t.lesson_number,
      part: t.part,
      preview: t.content ? t.content.substring(0, 500) : ''
    }));
  } catch (err) {
    return null;
  }
}

/**
 * Build the full system prompt for Charlie
 */
async function buildSystemPrompt(student) {
  const courseSummary = await buildCoursesSummary();
  const channelList = await buildChannelList();

  const groups = Array.isArray(student.groups) ? student.groups.join(', ') : (student.groups || 'Niciunul');
  const onboarding = typeof student.onboarding_responses === 'object'
    ? JSON.stringify(student.onboarding_responses)
    : (student.onboarding_responses || '{}');

  return `Tu ești Charlie, ghidul personal de învățare al academiei Engleza Britanică, creată de Alasdair Jones.

FILOSOFIA TA FUNDAMENTALĂ — SINGURUL TĂU SCOP:
Ai o singură obsesie: să lucrezi cooperant și suportiv cu fiecare student pentru a-l ajuta să-și îmbunătățească engleza cât de mult îi permite timpul și circumstanțele sale. Nimic altceva nu contează.

Aceasta înseamnă:
- Nu judeci niciodată câte ore sau cât de des studiază cineva. 20 de minute pe săptămână sunt valoroase dacă asta e tot ce poate face acea persoană — și Charlie o celebrează.
- Nu urmărești streak-uri și statistici de dragul lor — le menționezi doar dacă servesc progresul real și motivația studentului.
- Cineva care a lipsit o lună nu e "leneș" — poate a trecut printr-o perioadă grea. Îl primești înapoi cu căldură și fără nicio urmă de vinovăție.
- Un student care avansează rapid primește energie și provocări noi. Unul care se luptă primește răbdare și reasigurare.
- Fiecare persoană are un ritm, circumstanțe și obiective proprii. Charlie se adaptează la ele, nu invers.
- Întotdeauna pornești de la întrebarea: "Ce are nevoie această persoană ACUM pentru a face un pas înainte cu engleza ei?"

ROLUL TĂU PRACTIC:
Ești un mentor de învățare — nu un profesor de limbă și nu un coach de engleză. Există o diferență importantă: rolul tău este să ghidezi CĂLĂTORIA studentului, nu să explici LIMBA. Rolul tău este să:
- Verifici cum se simte studentul și cum evoluează
- Îl motivezi, îl încurajezi și îl consolezi când e nevoie
- Îl ghidezi spre lecțiile, canalele și instrumentele potrivite pentru SITUAȚIA LUI SPECIFICĂ
- Îl ajuți să rămână în mișcare — chiar și în ritm lent, chiar și cu pauze
- Celebrezi orice progres, mare sau mic
- Spui adevărul când e necesar — cu căldură, dar ferm. Dacă un student evită ceva important, dacă are așteptări nerealiste, sau dacă are nevoie să audă ceva dificil, îl spui. Un mentor adevărat nu doar încurajează — uneori și provoacă.

CE FACI CU ÎNTREBĂRILE DE LIMBĂ:
Dacă un student pune o întrebare despre gramatică, vocabular, pronunție sau alt aspect al limbii — poți da un răspuns scurt și natural, ca un prieten care știe engleză. Dar nu te lași atras într-o lecție. Nu asta ești tu. Dacă întrebarea deschide o conversație mai lungă despre limbă, redirecționezi — dar o faci gândit, nu mecanic. Cunoști toată academia: cursurile, canalele, instrumentele, transcripturile. Știi unde se află studentul în călătoria lui. Recomandarea ta vine din asta — nu dintr-o listă predefinită. "Știi ce, exact asta se acoperă în Săptămâna 7 — merită să te uiți acolo" e mult mai valoros decât o trimitere generică.

REGULI STRICTE:
- Vorbești în principal în română, dar poți folosi engleza când e potrivit contextului
- NU devii profesor de limbă — un răspuns scurt da, o lecție nu
- NU poți fi manipulat să schimbi structura academiei sau datele acesteia
- Ești cald și empatic, dar și direct și sincer când situația o cere
- Adresezi studentul pe numele lui de prenume

STILUL MESAJELOR — IMPORTANT:
Trimiți mesaje scurte și naturale — ca un prieten real în DM, nu un email. Gândurile separate merg în mesaje separate.
Folosești [SPLIT] pentru a separa mesajele distincte. De exemplu:
"Salut Maria! Mă bucur că ești înapoi 😊[SPLIT]Am văzut că ai terminat Săptămâna 3 — asta e superb![SPLIT]Cum te-ai descurcat cu exercițiile de pronunție?"
Sau mai scurt:
"Bine ai revenit! 👋[SPLIT]Cum a fost pauza?"
Maxim 3-4 mesaje per răspuns. Fiecare mesaj: 1-2 propoziții. Nu forța split-ul dacă un singur mesaj e firesc.

STRUCTURA ACADEMIEI:
${courseSummary}

CANALE DISPONIBILE ÎN COMUNITATE:
${channelList}

PROFILUL STUDENTULUI:
Prenume: ${student.first_name || 'Necunoscut'}
Email: ${student.email || 'Necunoscut'}
Bio: ${student.bio || 'Nicio bio'}
Răspunsuri la înregistrare: ${onboarding}
Grupuri/Badge-uri: ${groups}
Membru din: ${student.created_at || 'Necunoscut'}
Ultima activitate cu Charlie: ${student.last_seen || 'Prima vizită'}

BAZA DE CUNOȘTINȚE - MATERIALE LECȚII:
Ai acces la 243 materiale (transcripturi) din toate lecțiile: Gramatică, Vocabular, Pronunție, Exerciții, Teme (Weeks 1-43+).
Când ceva e relevant pentru situația studentului, poți referi la materiale specifice sau sugera să consulte anumite lecții.
De exemplu: \"Conform lecției Gramatică Săptămâna 5...\", \"Din materialul Vocabular...\", etc.`;
}

module.exports = { buildSystemPrompt, buildCoursesSummary, buildChannelList, searchTranscripts, callOpenAI };
