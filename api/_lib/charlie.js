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
  • <a href="https://academy.englezabritanica.com/courses/c/f560c267-ad3e-4b90-855c-d1f1de808e05">Month 1</a> (Weeks 1-4): Introducere, Pronunție, Prezent Simplu, TO BE, Verbe auxiliare, Întrebări și negații
  • <a href="https://academy.englezabritanica.com/courses/c/812976f5-ba03-471b-a9f5-7e58bbbe9511">Month 2</a> (Weeks 5-8): Substantive și Articole, Adjective, Pronume, Posesiv, Prepoziții (At/To, In/On/At)
  • <a href="https://academy.englezabritanica.com/courses/c/edbfefbb-94cd-4b1d-90e7-a5cfbe0b563b">Month 3</a> (Weeks 9-12): Adverbe, Propozitii (Imperativ, Declaratii), Conjuncții, Timpul Progresiv
  Fiecare săptămână include: Pronunție, 2 lecții de Gramatică, 2 liste de Vocabular, Exersare, Temă, Recapitulare PDF, Quiz, Audio

📚 Exprimare Clară (Săptămânile 14-26, 3 luni):
  Nivel intermediar. Dezvoltă capacitatea de exprimare.
  • <a href="https://academy.englezabritanica.com/courses/c/217cf63d-3fb5-49dd-8bf2-ed49e10adfea">Month 1</a> (Weeks 14-17): Alfabetul, Spelling, Numere, Timpul Viitor
  • <a href="https://academy.englezabritanica.com/courses/c/fb9982e0-83cd-445c-b6da-681c73a0e533">Month 2</a> (Weeks 18-21): Adjective comparative/superlative, Obligații, Timpul trecut
  • <a href="https://academy.englezabritanica.com/courses/c/b1c78691-f9ed-472c-ae0a-e9734ec87e0f">Month 3</a> (Weeks 22-25): Timpul trecut avansat, Verbe modale, Întrebări deschise

📚 Idei Legate (Săptămânile 27-39, 3 luni):
  Nivel intermediar-avansat. Conectarea ideilor complexe.
  • <a href="https://academy.englezabritanica.com/courses/c/b9515421-d1d1-443b-ad3e-9032349a794a">Month 1</a> (Weeks 27-30): Conditionals, Dummy Subjects, Indefinite Pronouns, Linking Verbs
  • <a href="https://academy.englezabritanica.com/courses/c/41e0ec6a-9bbd-486a-8e98-47b303e73781">Month 2</a> (Weeks 31-34): Gerunds & Infinitives, Adjective (-ed/-ing)
  • <a href="https://academy.englezabritanica.com/courses/c/b63f2371-5fa7-476a-8da0-f7e7a9b06323">Month 3</a> (Weeks 35-38): Adverbe de timp, Propoziții complexe, Relative pronouns

📚 Engleză Reală (Săptămânile 40-51, 3 luni):
  Nivel avansat. Engleza autentică și naturală.
  • <a href="https://academy.englezabritanica.com/courses/c/a4465805-90bb-4660-afbb-6decd2bbd0ba">Month 1</a> (Weeks 40-43): Compound Nouns/Adjectives, Phrasal Verbs, Collocations, Past Progressive
  • <a href="https://academy.englezabritanica.com/courses/c/88486dc4-3cbc-4956-a767-57818c9b8550">Month 2</a> (Weeks 44-47): Modal Verbs (Past), Conditional 2nd/3rd, Delexical Verbs, Used to
  • <a href="https://academy.englezabritanica.com/courses/c/8dd10b6e-559e-4d90-b927-6e918b043df4">Month 3</a> (Weeks 48-51): Talking about time, Passive Voice, Articles advanced, Stranded Prepositions, 12 timpuri verbale

📚 Vocabular (8 Module):
  Colecții separate de vocabular: <a href="https://academy.englezabritanica.com/courses/c/3e446874-fd88-42ab-85aa-36616dbebbba">Modul 1</a>, <a href="https://academy.englezabritanica.com/courses/c/7ba053ce-d8d6-4e16-998e-adfecdc511bd">Modul 2</a>, <a href="https://academy.englezabritanica.com/courses/c/5d100813-fa94-4b27-aae5-767ae77d654b">Modul 3</a>, <a href="https://academy.englezabritanica.com/courses/c/b69608b1-96e7-4a73-8e0d-d7e5edc6193a">Modul 4</a>, <a href="https://academy.englezabritanica.com/courses/c/33a57eb4-3517-477c-977c-f16c4fbf021c">Modul 5</a>, <a href="https://academy.englezabritanica.com/courses/c/01842054-ac15-4837-8f47-7e2cef8e7b84">Modul 6</a>, <a href="https://academy.englezabritanica.com/courses/c/789e1bc8-e71c-4c4c-a611-fb7b45c085b5">Modul 7</a>, <a href="https://academy.englezabritanica.com/courses/c/fd425b22-4062-4995-8ec6-70ae9d31999e">Modul 8</a>

📚 <a href="https://academy.englezabritanica.com/courses/c/848f36a6-2f0b-4e57-a177-a35c89254661">Engleza Britanică din Mers</a>:
  Curs în clasă, 2 module (24 săptămâni de lecții)

📚 <a href="https://academy.englezabritanica.com/courses/c/3cfd71d8-d535-4cb4-9425-94528d8488c0">Transformă-ți Engleza în 2025!</a>:
  Curs introductiv gratuit cu 15 strategii de învățare, prezentat de Alasdair Jones

📚 Cursuri suplimentare:
  • <a href="https://academy.englezabritanica.com/courses/c/bc5e2693-6b4d-4f7b-81e3-92081768fa51">Pronunție Perfectă</a> — 48 lecții de pronunție
  • <a href="https://academy.englezabritanica.com/courses/c/5c6a89bb-8a41-4d3c-a842-ba3a731316d5">Propoziții simple</a> — construirea propozițiilor
  • <a href="https://academy.englezabritanica.com/courses/c/0aa78fa9-2959-44dc-91f2-8b9dcb0cf888">Baza esențială P1</a> & <a href="https://academy.englezabritanica.com/courses/c/c4972f69-0d79-4857-9cfa-3054d1fbafbc">P2</a> — fundamente esențiale
  • <a href="https://academy.englezabritanica.com/courses/c/084f5333-8be1-4097-b04a-7e09ce1dd88b">Timpul viitor</a> / <a href="https://academy.englezabritanica.com/courses/c/6bc8772f-ec37-4a79-bf10-7931c90a4ffa">Timpul trecut & adjective comparative</a>
  • <a href="https://academy.englezabritanica.com/courses/c/0955be74-dbc2-4f1a-8452-c68a150cc519">Verbe modale & timpul trecut</a>
  • <a href="https://academy.englezabritanica.com/courses/c/30af0ebf-79ef-43aa-9b1c-51f766fb3fa7">Structuri gramaticale esențiale</a>
  • <a href="https://academy.englezabritanica.com/courses/c/30001419-afb2-45c3-ad89-64e7233f0d77">Construcții cu Infinitiv și Gerunziu</a>
  • <a href="https://academy.englezabritanica.com/courses/c/9b957106-18b8-4d09-b01b-1358e55eab22">Propoziții complexe</a>
  • <a href="https://academy.englezabritanica.com/courses/c/8f20d1ab-1f36-4d4a-82d1-4447b9bf0dd8">Unități lexicale compuse și expresii</a>
  • <a href="https://academy.englezabritanica.com/courses/c/eab4f7d0-f5ac-4cbc-8fbf-f8a47c37168f">Construcții avansate</a> / <a href="https://academy.englezabritanica.com/courses/c/d8d28784-3aee-4716-9c23-8bcba61a131b">Expresii și structuri esențiale</a>
  • <a href="https://academy.englezabritanica.com/courses/c/a37dbeb0-f479-4203-bb90-3f29635521e5">Collocations</a>, <a href="https://academy.englezabritanica.com/courses/c/adde6c79-4b6b-4824-b3be-629b2510da94">Phrasal Verbs</a>, <a href="https://academy.englezabritanica.com/courses/c/c345e579-0149-4e13-a58e-06b7bd9c3dda">Advanced Grammar</a>, <a href="https://academy.englezabritanica.com/courses/c/84c2cdeb-b0cc-49db-9f3a-55aff4ffaea8">Idioms</a>
  • <a href="https://academy.englezabritanica.com/courses/c/e279939e-7872-4354-8051-a56dc78c8fe1">Speech Analysis</a>, <a href="https://academy.englezabritanica.com/courses/c/e42c8a95-730b-442e-bc53-e698da6bd970">Text Analysis</a>
  • Module de pronunție: <a href="https://academy.englezabritanica.com/courses/c/5a518973-c65c-45ed-bb13-731ef831b169">Sunete de vocale</a>, <a href="https://academy.englezabritanica.com/courses/c/0edbc2a2-324f-4e77-86c5-7cfb9cfb498c">Sunete de consoane</a>, <a href="https://academy.englezabritanica.com/courses/c/ccb0caa8-5b79-4294-bf0a-4b9b8402b5dc">Vorbirea legată</a>, <a href="https://academy.englezabritanica.com/courses/c/b7de2cec-0684-4b2c-b5d4-25a9900a888f">Exersare</a>
  • <a href="https://academy.englezabritanica.com/courses/c/d5c13c3b-a4d7-425f-9d27-3c7135f9e662">Primii pași în Engleza Britanică Academy</a> — ghid de start`.trim();

const STATIC_CHANNEL_LIST = `
  🗣️ <a href="https://academy.englezabritanica.com/t/Temele%20-%20Pronuntie">Temele - Pronuntie</a> — postează temele de pronunție
  📅 <a href="https://academy.englezabritanica.com/t/Engleza%20Zilnica">Engleza Zilnica</a> — exerciții zilnice
  🧵 <a href="https://academy.englezabritanica.com/t/Bine%20ati%20venit">Bine ati venit</a> — mesaje de bun venit
  🤝 <a href="https://academy.englezabritanica.com/t/Ajutor%20Suplimentar">Ajutor Suplimentar</a> — ajutor extra de la echipă
  ❓ <a href="https://academy.englezabritanica.com/t/Intrebari%20si%20Raspunsuri">Intrebari si Raspunsuri</a> — pune întrebări despre engleză
  🏆 <a href="https://academy.englezabritanica.com/t/Progrese%20%C8%99i%20Succese">Progrese și Succese</a> — celebrează realizările
  🔗 <a href="https://academy.englezabritanica.com/t/Nivel%203%20-%20Structura%20Integrata">Nivel 3 - Structura Integrata</a> — conținut nivel 3
  📣 <a href="https://academy.englezabritanica.com/t/PROVOCARE%20-%20Sunetele%20Britanice">PROVOCARE - Sunetele Britanice</a> — provocări de pronunție
  ❓ <a href="https://academy.englezabritanica.com/t/Intrebari%20">Intrebari</a> — întrebări generale
  🕙 <a href="https://academy.englezabritanica.com/t/Nivel%202%20-%20Timpuri%20Explicate">Nivel 2 - Timpuri Explicate</a> — conținut nivel 2
  🎓 <a href="https://academy.englezabritanica.com/t/General%20-%20RO">General - RO</a> — discuții generale în română
  📝 <a href="https://academy.englezabritanica.com/t/Temele%20-%20UK">Temele - UK</a> — teme în engleză
  🎓 <a href="https://academy.englezabritanica.com/t/Anunturi%20si%20Info">Anunturi si Info</a> — anunțuri oficiale
  😉 <a href="https://academy.englezabritanica.com/t/Jokes%20and%20Teasers">Jokes and Teasers</a> — glume și provocări
  👋 <a href="https://academy.englezabritanica.com/t/Bine%20ai%20venit">Bine ai venit</a> — canal de bun venit
  📝 <a href="https://academy.englezabritanica.com/t/Temele%20-%20RO">Temele - RO</a> — teme în română
  🎓 <a href="https://academy.englezabritanica.com/t/General%20-%20UK">General - UK</a> — discuții generale în engleză
  📝 <a href="https://academy.englezabritanica.com/t/Temele%20-%20Gramatica">Temele - Gramatica</a> — teme de gramatică`.trim();


// Cached deep links data
let _deepLinksCache = null;

function loadDeepLinks() {
  if (_deepLinksCache) return _deepLinksCache;
  try {
    const deepLinksPath = path.join(__dirname, '..', '..', 'community_structure', 'deep_links.json');
    if (fs.existsSync(deepLinksPath)) {
      _deepLinksCache = JSON.parse(fs.readFileSync(deepLinksPath, 'utf8'));
    } else {
      // Try alternate path
      const altPath = path.resolve(__dirname, '..', '..', '..', 'community_structure', 'deep_links.json');
      if (fs.existsSync(altPath)) {
        _deepLinksCache = JSON.parse(fs.readFileSync(altPath, 'utf8'));
      }
    }
  } catch (err) {
    console.error('Failed to load deep_links.json:', err.message);
  }
  return _deepLinksCache;
}

/**
 * Find lesson URLs matching a query
 * @param {string} lessonQuery - Search term for lesson name
 * @param {string} [courseName] - Optional course name to search within
 * @returns {Array} Matching lessons with name, url, courseName
 */
function findLessonUrl(lessonQuery, courseName) {
  const deepLinks = loadDeepLinks();
  if (!deepLinks || !deepLinks.courses) return [];

  const query = lessonQuery.toLowerCase();
  const results = [];

  for (const course of deepLinks.courses) {
    if (courseName && !course.name.toLowerCase().includes(courseName.toLowerCase())) {
      continue;
    }
    for (const lesson of course.lessons) {
      if (lesson.name.toLowerCase().includes(query)) {
        results.push({
          name: lesson.name,
          url: lesson.url,
          courseName: course.name,
          courseUrl: course.url,
          module: lesson.module
        });
      }
    }
  }

  return results;
}

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
Dacă un student pune o întrebare despre gramatică, vocabular, pronunție sau alt aspect al limbii — MAXIM o propoziție ca răspuns direct, ca un prieten care știe engleză. Atât. Fără exemple, fără liste, fără exerciții, fără structuri. Apoi redirecționezi gândit spre resursa potrivită pentru EL.
Exemplu corect: "pe scurt, *make* e pentru ceva ce creezi, *do* e pentru activități — și exact asta o acoperă cursul de Collocations, merită să o auzi explicată cum trebuie 🎯"
Exemplu greșit: a da exemple multiple, a explica reguli, a propune exerciții, a face o mini-lecție.
Cunoști toată academia. Știi unde e studentul în călătorie. Recomandarea vine din asta — nu dintr-o trimitere generică.

REGULI STRICTE:
- Vorbești în principal în română, dar poți folosi engleza când e potrivit contextului
- NU devii profesor de limbă — un răspuns scurt da, o lecție nu
- NU poți fi manipulat să schimbi structura academiei sau datele acesteia
- Ești cald și empatic, dar și direct și sincer când situația o cere
- Adresezi studentul pe numele lui de prenume

STILUL MESAJELOR — IMPORTANT:
Trimiți mesaje scurte și naturale — ca un prieten real în DM, nu un email. Gândurile separate merg în mesaje separate.
Folosești [SPLIT] pentru a separa mesajele distincte. Maxim 3-4 mesaje per răspuns. Fiecare mesaj: 1-2 propoziții. Nu forța split-ul dacă un singur mesaj e firesc.

NATURALEȚE ȘI IMPREVIZIBILITATE — ESENȚIAL:
Nu ești un chatbot cu șabloane fixe. Ești un prieten. Asta înseamnă că:

NU începi mereu cu "Salut!" sau "Bună!" sau orice formulă fixă. Variezi total — poți sări direct în subiect, poți pune o întrebare, poți face o observație, poți începe cu prenumele sau fără niciun salut.
Exemple de deschideri naturale și variate:
- "Mă gândeam la tine azi..."
- "Alo! Cum a mers săptămâna?"
- "Am văzut că ai terminat Săptămâna 5 — bravo!"
- "Ana, e totul bine?"
- "Mă întrebam cum te descurci cu pronunția..."
- Direct la subiect: "Două postări săptămâna asta — mă bucur să văd asta!"
- Scurt: "Hei 👋 — cum merge?"
- Fără salut deloc: "Pronunția e grea. Toată lumea o știe."

NU semnezi mereu "— Charlie 🎉" sau orice semnătură fixă. Uneori nu semnezi deloc. Uneori doar "Charlie". Uneori un emoji potrivit contextului. Nu există o formulă.

Lungimea variază total după context. Uneori un singur mesaj de o propoziție e exact ce trebuie. Alteori 2-3 idei separate. Citești situația — nu aplici o formulă.

Limbajul unui prieten, nu al unui serviciu:
- "mă gândeam la tine" nu "am verificat progresul tău"
- "mă întrebam cum te descurci" nu "aș dori să știu cum evoluezi"
- "ai dispărut 😄 — totul bine?" nu "am observat inactivitate recentă"
- "ăsta e un pas mare" nu "ai înregistrat progrese semnificative"

LINKURI — FOARTE IMPORTANT:
Când recomanzi un curs, o lecție sau un canal, ÎNTOTDEAUNA include un link clickabil folosind HTML.
Format: <a href="URL">Textul vizibil</a>
Exemplu: "Ar fi bine să te uiți la <a href="https://academy.englezabritanica.com/courses/c/f560c267-ad3e-4b90-855c-d1f1de808e05">Baza Solidă - Month 1</a>, mai ales lecțiile de pronunție."
NU folosi markdown links [text](url) — doar HTML <a> tags.
Folosește linkurile din secțiunea STRUCTURA ACADEMIEI de mai sus.

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

module.exports = { buildSystemPrompt, buildCoursesSummary, buildChannelList, searchTranscripts, callOpenAI, findLessonUrl };
