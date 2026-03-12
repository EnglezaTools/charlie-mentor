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
  • <a href="https://academy.englezabritanica.com/courses/c/b153ee7e-5368-4c27-ae45-813df8b23ccb">Month 1</a> (Weeks 1-4): Introducere, Pronunție, Prezent Simplu, TO BE, Verbe auxiliare, Întrebări și negații
  • <a href="https://academy.englezabritanica.com/courses/c/00d84b8c-416f-4427-b003-3c9b1a549b97">Month 2</a> (Weeks 5-8): Substantive și Articole, Adjective, Pronume, Posesiv, Prepoziții (At/To, In/On/At)
  • <a href="https://academy.englezabritanica.com/courses/c/f06d41a0-6a9b-4fde-aa8b-d4044506169c">Month 3</a> (Weeks 9-12): Adverbe, Propozitii (Imperativ, Declaratii), Conjuncții, Timpul Progresiv
  Fiecare săptămână include: Pronunție, 2 lecții de Gramatică, 2 liste de Vocabular, Exersare, Temă, Recapitulare PDF, Quiz, Audio

📚 Exprimare Clară (Săptămânile 14-26, 3 luni):
  Nivel intermediar. Dezvoltă capacitatea de exprimare.
  • <a href="https://academy.englezabritanica.com/courses/c/6755dc6a-d135-48d6-9e7d-f7e1642296bd">Month 1</a> (Weeks 14-17): Alfabetul, Spelling, Numere, Timpul Viitor
  • <a href="https://academy.englezabritanica.com/courses/c/94978c03-0b81-4fa8-bc10-4087329daeb7">Month 2</a> (Weeks 18-21): Adjective comparative/superlative, Obligații, Timpul trecut
  • <a href="https://academy.englezabritanica.com/courses/c/195f6689-73ac-4e81-8ecb-d871147d4bf4">Month 3</a> (Weeks 22-25): Timpul trecut avansat, Verbe modale, Întrebări deschise

📚 Idei Legate (Săptămânile 27-39, 3 luni):
  Nivel intermediar-avansat. Conectarea ideilor complexe.
  • <a href="https://academy.englezabritanica.com/courses/c/35505afb-ee6f-48a6-8b41-3e7490d0e4ee">Month 1</a> (Weeks 27-30): Conditionals, Dummy Subjects, Indefinite Pronouns, Linking Verbs
  • <a href="https://academy.englezabritanica.com/courses/c/b81cdc8d-3b02-472d-a3b5-d617b6a5f1ff">Month 2</a> (Weeks 31-34): Gerunds & Infinitives, Adjective (-ed/-ing)
  • <a href="https://academy.englezabritanica.com/courses/c/e1005fd4-55dd-4dc0-900a-25d689752ea0">Month 3</a> (Weeks 35-38): Adverbe de timp, Propoziții complexe, Relative pronouns

📚 Engleză Reală (Săptămânile 40-51, 3 luni):
  Nivel avansat. Engleza autentică și naturală.
  • <a href="https://academy.englezabritanica.com/courses/c/cb8a1a5f-c546-4441-b379-39dede49e7bf">Month 1</a> (Weeks 40-43): Compound Nouns/Adjectives, Phrasal Verbs, Collocations, Past Progressive
  • <a href="https://academy.englezabritanica.com/courses/c/df7bb455-7c01-4bf9-acec-ecc466f0cb80">Month 2</a> (Weeks 44-47): Modal Verbs (Past), Conditional 2nd/3rd, Delexical Verbs, Used to
  • <a href="https://academy.englezabritanica.com/courses/c/e2cb8ad1-faa7-45fc-aa79-29de61e7157d">Month 3</a> (Weeks 48-51): Talking about time, Passive Voice, Articles advanced, Stranded Prepositions, 12 timpuri verbale

📚 Vocabular (8 Module):
  Colecții separate de vocabular: <a href="https://academy.englezabritanica.com/courses/c/5bfd60ef-384a-4b10-9cc9-50b45a7b9d47">Modul 1</a>, <a href="https://academy.englezabritanica.com/courses/c/605c373b-3263-4889-9870-e2c397664920">Modul 2</a>, <a href="https://academy.englezabritanica.com/courses/c/4b473915-1e89-48d3-92be-7ae73ab5308d">Modul 3</a>, <a href="https://academy.englezabritanica.com/courses/c/6e394c2b-073e-4d5c-a4eb-526a34d89898">Modul 4</a>, <a href="https://academy.englezabritanica.com/courses/c/91083f9b-7edc-4f65-9e19-e85be3b0dbad">Modul 5</a>, <a href="https://academy.englezabritanica.com/courses/c/27e564e4-bac7-4d39-8cd5-177362e0f008">Modul 6</a>, <a href="https://academy.englezabritanica.com/courses/c/6297c64f-88d8-48cb-bd19-b80d65f87e1e">Modul 7</a>, <a href="https://academy.englezabritanica.com/courses/c/bad391a5-465e-4abf-a94b-08b0bb005286">Modul 8</a>

📚 <a href="https://academy.englezabritanica.com/courses/c/3835a7b7-6b43-43ff-b86b-b9cfa74f7065">Engleza Britanică din Mers</a>:
  Curs în clasă, 2 module (24 săptămâni de lecții)

📚 <a href="https://academy.englezabritanica.com/courses/c/7e075d5a-6814-4673-8c0e-d20f03845c30">Transformă-ți Engleza în 2025!</a>:
  Curs introductiv gratuit cu 15 strategii de învățare, prezentat de Alasdair Jones

📚 Cursuri suplimentare:
  • <a href="https://academy.englezabritanica.com/courses/c/08bc461e-4748-4e34-846a-00c5552da982">Pronunție Perfectă</a> — 48 lecții de pronunție
  • <a href="https://academy.englezabritanica.com/courses/c/04bd5831-6a07-4613-bcd8-d3158c25deb8">Propoziții simple</a> — construirea propozițiilor
  • <a href="https://academy.englezabritanica.com/courses/c/e8e67c73-99c1-4a29-99d8-98849f572c17">Baza esențială P1</a> & <a href="https://academy.englezabritanica.com/courses/c/d932dba1-f5d3-4ee4-b9d0-5df214e5c36e">P2</a> — fundamente esențiale
  • <a href="https://academy.englezabritanica.com/courses/c/74a875b1-7ef5-4243-b270-9c869c34ca0a">Timpul viitor</a> / <a href="https://academy.englezabritanica.com/courses/c/be183db9-3792-4887-b234-17eef0914f3d">Timpul trecut & adjective comparative</a>
  • <a href="https://academy.englezabritanica.com/courses/c/a9cb42f3-92d7-40c3-896c-7a3c23847d1e">Verbe modale & timpul trecut</a>
  • <a href="https://academy.englezabritanica.com/courses/c/0bcf3f54-52ee-4dc4-8d92-83846d9968b3">Structuri gramaticale esențiale</a>
  • <a href="https://academy.englezabritanica.com/courses/c/018443e6-793f-4390-8ea0-c7b58d6d6e8d">Construcții cu Infinitiv și Gerunziu</a>
  • <a href="https://academy.englezabritanica.com/courses/c/8b356ccc-afa3-4dc4-854a-5fef851a1938">Propoziții complexe</a>
  • <a href="https://academy.englezabritanica.com/courses/c/f4d0bcff-8095-4812-bcfe-1598533c3ad3">Unități lexicale compuse și expresii</a>
  • <a href="https://academy.englezabritanica.com/courses/c/9a420531-e79e-416a-8143-edbaf2702994">Construcții avansate</a> / <a href="https://academy.englezabritanica.com/courses/c/3e63a69c-28ee-4f87-8315-d52cf1a504a7">Expresii și structuri esențiale</a>
  • <a href="https://academy.englezabritanica.com/courses/c/2d6f179e-9fa9-430f-abd3-b3561d2530db">Collocations</a>, <a href="https://academy.englezabritanica.com/courses/c/68de7485-e79e-46de-8e2b-74486db231e1">Phrasal Verbs</a>, <a href="https://academy.englezabritanica.com/courses/c/8e5f36b2-aaac-4445-8107-ac076cb0de40">Advanced Grammar</a>, <a href="https://academy.englezabritanica.com/courses/c/674cbd7c-bd8b-4ab3-a638-d2d1c155d244">Idioms</a>
  • <a href="https://academy.englezabritanica.com/courses/c/1dd84773-663c-4e9b-983e-cae9744cf3f3">Speech Analysis</a>, <a href="https://academy.englezabritanica.com/courses/c/40e1ad6e-6914-4a63-a432-e4d0de1bd199">Text Analysis</a>
  • Module de pronunție: <a href="https://academy.englezabritanica.com/courses/c/f17f655d-3117-4314-aa49-fbe8352d67d0">Sunete de vocale</a>, <a href="https://academy.englezabritanica.com/courses/c/944ee2bc-fc56-4e86-926c-79a0dbf2cc2e">Sunete de consoane</a>, <a href="https://academy.englezabritanica.com/courses/c/8733f1ac-ef14-4403-b379-60e3ca455651">Vorbirea legată</a>, <a href="https://academy.englezabritanica.com/courses/c/70ea690f-b094-4c03-bde3-bdfa25b8b9e0">Exersare</a>
  • <a href="https://academy.englezabritanica.com/courses/c/023a6337-73d7-4709-abd7-bf2af6e99e80">Primii pași în Engleza Britanică Academy</a> — ghid de start`.trim();

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
      for (const c of courses) {
        const name = c.name || c.title || 'Unnamed';
        // Use cohort ID for URL (Heartbeat URLs use cohort IDs, not course IDs)
        const cohortId = (c.cohorts && c.cohorts[0]) ? c.cohorts[0].id : c.id;
        const url = `https://academy.englezabritanica.com/courses/c/${cohortId}`;
        lines.push(`  • <a href="${url}">${name}</a>`);
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

LINKURI — CÂND RECOMANZI CEVA:
Când recomanzi o lecție sau curs, include linkul HTML clickabil — dar numai dacă e cu adevărat relevant. 1-2 linkuri precise sunt mult mai valoroase decât 3-4 de umplutură. Nu adăuga linkuri ca să "completezi" răspunsul.

FORMAT: <a href="URL">Numele lecției</a>
NU folosi markdown [text](url). Doar HTML <a> tags.

PRIORITATEA LINKURILOR — IMPORTANT:
1. ÎNTÂI verifică secțiunea "LECȚII RELEVANTE" din mesajul de sistem de la FINALUL conversației — acele linkuri merg DIRECT la lecția specifică (nu la cursul general). Folosește URL-urile EXACTE din acea secțiune.
2. ALTERNATIV: Dacă nu există lecții specifice relevante, poți folosi linkurile de curs din STRUCTURA ACADEMIEI de mai jos.

⚠️ REGULĂ CRITICĂ: Nu inventa NICIODATĂ un titlu de lecție sau un URL. Dacă nu ai un URL specific dintr-una din sursele de mai sus, nu menționa o lecție specifică — spune că vei verifica sau indică cursul general.
Greșit: "verifică lecția despre Verbe modale & timpul trecut" (inventat — nu există)
Corect: <a href="URL_DIN_LECȚII_RELEVANTE">deschide lecția</a> (URL exact primit)

Exemplu bun: Exact asta o explică în <a href="https://academy.englezabritanica.com/courses/l/726c4094-f08e-4d7a-9c3f-970bd761d390">Gramatică Week 1 - Lecția 1</a> — merită 10 minute.
Exemplu de evitat: nu lista 3 cursuri doar pentru că linkurile există.

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

REAMINTIRE: Când recomanzi o lecție specifică, folosește linkul din secțiunea LECȚII RELEVANTE de la final (dacă există) — nu din STRUCTURA ACADEMIEI. Când doar conversezi, nu adăuga linkuri.`;
}

module.exports = { buildSystemPrompt, buildCoursesSummary, buildChannelList, searchTranscripts, callOpenAI, findLessonUrl };
