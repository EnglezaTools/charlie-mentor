const { sendDirectMessage, getDirectMessages, getUserById } = require('./_lib/heartbeat');
const { callOpenAI, buildSystemPrompt } = require('./_lib/charlie');
const { supabase } = require('./_lib/supabase');

const CHARLIE_USER_ID = '4123ccdd-a337-4438-b5ff-fcaad1464102';

/**
 * Detect the webhook event type from payload shape.
 * Heartbeat does NOT include a 'type' field in webhook payloads.
 * Each event type has a distinct payload structure:
 *   DIRECT_MESSAGE: { senderUserID, receiverUserID, chatID, chatMessageID }
 *   COURSE_COMPLETED: { courseID, userID } or { courseName, userID }
 *   GROUP_JOIN: { userID, groupID }
 *   THREAD_CREATE: { id, channelID }
 *   USER_JOIN: { id, name, email }
 *   USER_UPDATE: { id } (only field)
 */
function detectEventType(event) {
  if (event.senderUserID && event.chatID) return 'DIRECT_MESSAGE';
  if (event.courseID || event.courseName) return 'COURSE_COMPLETED';
  if (event.groupID) return 'GROUP_JOIN';
  if (event.channelID && event.id) return 'THREAD_CREATE';
  if (event.email && event.name) return 'USER_JOIN';
  if (event.id && !event.channelID && !event.email) return 'USER_UPDATE';
  return 'UNKNOWN';
}

/**
 * Send a response as multiple natural DM messages, split on [SPLIT] markers
 * Adds realistic typing delays between messages
 */
async function sendSplitMessages(recipientId, response) {
  const parts = response.split('[SPLIT]').map(p => p.trim()).filter(p => p.length > 0);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      // Delay between messages: roughly proportional to message length, 600-1400ms
      const delay = Math.min(600 + parts[i].length * 12, 1400);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    await sendDirectMessage(recipientId, parts[i]);
  }
}

/**
 * Handle incoming Heartbeat webhook events
 * IMPORTANT: Process FIRST, then respond. Vercel kills the function after res.json().
 */
module.exports = async (req, res) => {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const event = req.body;
  console.log('[Webhook] Event received:', JSON.stringify(event).substring(0, 500));

  // Detect event type from payload shape FIRST so we can log it
  const detectedType = detectEventType(event);
  console.log('[Webhook] Detected event type:', detectedType);

  // Log raw payload to Supabase for debugging
  try {
    await supabase.from('activity_log').insert([{
      user_id: event.senderUserID || event.userID || event.user?.id || event.id || 'unknown',
      activity_type: 'WEBHOOK_RAW',
      activity_date: new Date().toISOString().split('T')[0],
      metadata: { detectedType, payload: event }
    }]);
  } catch (logErr) {
    console.warn('[Webhook] Debug log failed:', logErr.message);
  }

  // Process the event BEFORE responding (Vercel kills function after response)
  let result = 'ignored';
  try {
    switch (detectedType) {
      case 'DIRECT_MESSAGE':
        await handleDirectMessage(event);
        result = 'processed';
        break;
      case 'USER_JOIN':
        await handleUserJoin(event);
        result = 'processed';
        break;
      case 'GROUP_JOIN':
        await handleGroupJoin(event);
        result = 'processed';
        break;
      case 'USER_UPDATE':
        await handleUserUpdate(event);
        result = 'processed';
        break;
      case 'THREAD_CREATE':
        await handleThreadCreate(event);
        result = 'processed';
        break;
      case 'COURSE_COMPLETED':
        await handleCourseCompleted(event);
        result = 'processed';
        break;
      default:
        console.log('[Webhook] Could not detect event type from payload:', JSON.stringify(event).substring(0, 300));
    }
  } catch (err) {
    console.error('[Webhook] Processing error:', err.message, err.stack);
    result = `error: ${err.message}`;
  }

  // Respond AFTER processing is complete
  return res.status(200).json({ received: true, detectedType, result });
};

/**
 * When a student DMs Charlie
 */
async function handleDirectMessage(event) {
  try {
    const { senderUserID, receiverUserID, chatID, chatMessageID } = event;

    // Don't respond to our own messages
    if (senderUserID === CHARLIE_USER_ID) {
      return;
    }

    // Only handle messages sent TO Charlie
    if (receiverUserID && receiverUserID !== CHARLIE_USER_ID) {
      return;
    }

    console.log(`[DM] Message from ${senderUserID}, chatID: ${chatID}, msgID: ${chatMessageID}`);
    
    // Step tracking for debug
    let step = 'INIT';

    // Fetch actual message content from Heartbeat API
    step = 'FETCH_MESSAGE';
    let messageContent = '';
    try {
      const chatData = await getDirectMessages(chatID);
      // Heartbeat may return array or object with messages property
      const messages = Array.isArray(chatData) 
        ? chatData 
        : (chatData.messages || chatData.data || chatData.chatMessages || []);
      
      // Find the specific message by ID
      const found = messages.find(m => 
        m.id === chatMessageID || 
        m._id === chatMessageID || 
        m.chatMessageID === chatMessageID
      );
      
      // Extract text from found message or most recent from sender
      if (found) {
        messageContent = extractText(found);
      }
      
      if (!messageContent && messages.length > 0) {
        // Fallback: most recent message from sender
        const fromSender = messages.filter(m => 
          m.userID === senderUserID || 
          m.senderUserID === senderUserID ||
          m.sender?.id === senderUserID
        );
        if (fromSender.length > 0) {
          const latest = fromSender[fromSender.length - 1];
          messageContent = extractText(latest);
        }
      }
      
      console.log(`[DM] Message content: "${messageContent.substring(0, 150)}"`);
    } catch (fetchErr) {
      console.warn('[DM] Could not fetch message content:', fetchErr.message);
    }

    if (!messageContent) {
      messageContent = '(student sent a message - content unavailable)';
    }

    // Get student profile from Heartbeat
    step = 'GET_STUDENT';
    const student = await getUserById(senderUserID).catch(() => null);
    const studentId = student?.heartbeat_id || senderUserID;

    // Detect language of student's message (simple: count Romanian vs English patterns)
    const messageLanguage = detectLanguage(messageContent);
    
    // Build Charlie's context-aware system prompt (pass full student object, fallback to empty)
    const systemPrompt = await buildSystemPrompt(student || { heartbeat_id: studentId, groups: [], onboarding_responses: {} }, messageLanguage);

    // Get conversation history for continuity
    const { data: history } = await supabase
      .from('conversations')
      .select('role, content')
      .eq('student_id', studentId)
      .order('created_at', { ascending: false })
      .limit(10);

    // Build messages array for OpenAI
    const messages = [{ role: 'system', content: systemPrompt }];
    
    // Add recent history (reversed to be chronological)
    if (history && history.length > 0) {
      const recentHistory = history.reverse();
      for (const h of recentHistory) {
        if (h.role && h.content) {
          messages.push({ role: h.role, content: h.content });
        }
      }
    }
    
    // Add current message
    messages.push({ role: 'user', content: messageContent });

    // Detect and save any preferences expressed in the student's message (non-blocking)
    let detectedPrefs = null;
    try {
      detectedPrefs = await detectPreferences(messageContent);
      if (detectedPrefs) {
        await savePreferences(studentId, detectedPrefs);
        console.log(`[DM] Preferences detected and saved for ${studentId}:`, JSON.stringify(detectedPrefs));
      }
    } catch (prefErr) {
      console.warn('[DM] Preference detection failed (non-fatal):', prefErr.message);
    }

    // If preferences were detected, add context so Charlie can acknowledge them naturally
    if (detectedPrefs) {
      const prefsContext = buildPreferencesContext(detectedPrefs);
      messages[0].content += `\n\n${prefsContext}`;
    }

    // Search lesson_index for relevant lessons based on student's message
    // Inject as a SEPARATE system message at the END (just before API call)
    // so it's the most recently seen context — not buried in the long system prompt
    let lessonSystemMsg = null;
    try {
      const relevantLessons = await findRelevantLessons(messageContent, supabase);
      if (relevantLessons && relevantLessons.length > 0) {
        const lessonContext = buildLessonContext(relevantLessons);
        lessonSystemMsg = { role: 'system', content: lessonContext };
        console.log(`[DM] Found ${relevantLessons.length} relevant lessons for: "${messageContent.substring(0, 60)}"`);
      }
    } catch (lessonErr) {
      console.warn('[DM] Lesson search failed (non-fatal):', lessonErr.message);
    }

    // Get Charlie's response
    // Insert lesson context as final system message (highest priority, seen last)
    if (lessonSystemMsg) {
      messages.push(lessonSystemMsg);
    }

    step = 'CALL_OPENAI';
    const response = await callOpenAI(messages, { max_tokens: 300, temperature: 0.7 });

    // Send response back to student (split into natural conversational messages)
    step = 'SEND_REPLY';
    await sendSplitMessages(senderUserID, response);

    // Ensure student exists in students table (for foreign key)
    try {
      const studentName = student?.name || student?.displayName || 'Unknown';
      const studentEmail = student?.email || `${senderUserID}@heartbeat.user`;
      await supabase
        .from('students')
        .upsert({ 
          id: studentId, 
          heartbeat_id: senderUserID, 
          name: studentName,
          email: studentEmail
        }, { onConflict: 'id', ignoreDuplicates: true });
    } catch (_) {}

    // Store conversation in database (two rows: user message + assistant response)
    try {
      const { data: saveData, error: saveErr } = await supabase
        .from('conversations')
        .insert([
          { student_id: studentId, role: 'user', content: messageContent },
          { student_id: studentId, role: 'assistant', content: response }
        ]);
      
      // Log save result to activity_log so we can debug
      await supabase.from('activity_log').insert([{
        user_id: senderUserID,
        activity_type: saveErr ? 'CONV_SAVE_ERROR' : 'CONV_SAVED',
        activity_date: new Date().toISOString().split('T')[0],
        metadata: saveErr 
          ? { error: saveErr.message, code: saveErr.code, studentId }
          : { studentId, messagePreview: messageContent.substring(0, 100), responsePreview: response.substring(0, 100) }
      }]);
    } catch (dbErr) {
      // Even the logging failed - try one more time
      try {
        await supabase.from('activity_log').insert([{
          user_id: senderUserID,
          activity_type: 'CONV_SAVE_CRASH',
          activity_date: new Date().toISOString().split('T')[0],
          metadata: { error: dbErr.message }
        }]);
      } catch (_) {}
    }

    // Track conversation session for active window detection (non-blocking)
    trackMessageSession(studentId).catch(() => {});

    console.log('[DM] Responded to', senderUserID);
    return;
  } catch (err) {
    console.error('[DM] Handler error:', err.message, err.stack);
    // Log error to Supabase so we can actually see it
    try {
      await supabase.from('activity_log').insert([{
        user_id: event?.senderUserID || 'unknown',
        activity_type: 'DM_ERROR',
        activity_date: new Date().toISOString().split('T')[0],
        metadata: { step, error: err.message, stack: err.stack?.substring(0, 500) }
      }]);
    } catch (_) {}
    return;
  }
}

/**
 * Detect if message is in English or Romanian
 */
function detectLanguage(text) {
  if (!text) return 'romanian'; // default
  
  const lower = text.toLowerCase();
  
  // Common Romanian words/patterns
  const roPatterns = [
    'și', 'este', 'sunt', 'care', 'în', 'de', 'cu', 'pentru', 'pe', 
    'este', 'ți', 'scriu', 'mă', 'te', 'voi', 'ești', 'vreau', 'pot',
    'curs', 'lectie', 'lecție', 'engleza', 'cum', 'ce', 'cand', 'când',
    'daca', 'dacă', 'incerc', 'incerc', 'greu', 'problema'
  ];
  
  // Common English words/patterns
  const enPatterns = [
    'and', 'the', 'is', 'are', 'for', 'you', 'me', 'my', 'what', 'how',
    'can', 'will', 'would', 'should', 'could', 'lesson', 'help', 'thanks',
    'about', 'understand', 'question', 'think', 'good', 'okay', 'really'
  ];
  
  let roScore = 0, enScore = 0;
  for (const word of roPatterns) {
    if (lower.includes(word)) roScore += 2;
  }
  for (const word of enPatterns) {
    if (lower.includes(word)) enScore += 2;
  }
  
  // Also check for accent patterns (Romanian has ă, ț, ş, ş, etc.)
  if (/[ăîțşğ]/.test(text)) roScore += 10;
  
  return enScore > roScore ? 'english' : 'romanian';
}

/**
 * Extract text content from a message object
 */
function extractText(msg) {
  if (!msg) return '';
  // Try various field names Heartbeat might use
  const raw = msg.text || msg.message || msg.body || msg.content || 
         msg.richText?.text || msg.richText?.body || 
         (typeof msg.richText === 'string' ? msg.richText : '') || '';
  // Strip HTML tags (Heartbeat sends content as HTML like <p>hello</p>)
  return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * When a new student joins the community
 */
async function handleUserJoin(event) {
  try {
    // Heartbeat USER_JOIN event - check various field names
    const userId = event.userID || event.user_id || event.id;
    const userName = event.fullName || event.name || event.user_name || event.username || 'novo student';
    const userEmail = event.email || event.user_email || '';

    console.log(`[USER_JOIN] ${userName} (${userId}) joined`);

    // Generate warm welcome message via AI
    const welcomeMsgs = await callOpenAI([
      {
        role: 'system',
        content: 'Ești Charlie, mentorul personal de engleză la academia Engleza Britanică. Ești cald, prietenos, ca un prieten bun. Vorbești în română. Când trimiți mai multe mesaje separate, le separi cu [SPLIT].'
      },
      {
        role: 'user',
        content: `Un student nou tocmai s-a alăturat comunității: ${userName}. Scrie un mesaj de bun venit NATURAL și SCURT — ca și cum ai bate pe umăr pe cineva nou. Prezintă-te pe scurt ca Charlie, mentorul lor. Spune că ești acolo pentru ei pe tot parcursul călătoriei — nu să predai, ci să ghideze și să sprijine. Invită-i să-ți scrie oricând. Poți folosi [SPLIT] pentru a trimite 2-3 mesaje scurte și naturale în loc de un bloc mare de text. Fii prietenos, nu formal.`
      }
    ]);
    await sendSplitMessages(userId, welcomeMsgs);

    // Upsert student record
    try {
      await supabase
        .from('students')
        .upsert({
          student_id: userId,
          heartbeat_id: userId,
          email: userEmail,
          name: userName,
          last_interaction: new Date().toISOString()
        }, { onConflict: 'heartbeat_id' });
    } catch (dbErr) {
      console.warn('[USER_JOIN] Could not save student:', dbErr.message);
    }

    console.log('[USER_JOIN] Welcome sent to', userName);
    return;
  } catch (err) {
    console.error('[USER_JOIN] Handler error:', err.message);
    return;
  }
}

/**
 * When a user's profile or groups are updated — used to capture logins
 * Heartbeat fires this when the "Log-in" or "Active" group is assigned
 */
async function handleUserUpdate(event) {
  try {
    const userId = event.id || event.userID || event.user_id;
    if (!userId) {
      return;
    }

    // Skip Charlie's own account
    if (userId === CHARLIE_USER_ID) {
      return;
    }

    console.log(`[USER_UPDATE] Checking user ${userId}`);

    // Fetch user to inspect their groups
    const user = await getUserById(userId);
    if (!user) {
      console.log(`[USER_UPDATE] Could not find user ${userId}`);
      return;
    }

    // Skip admins
    if (user.is_admin) {
      return;
    }

    const groups = user.groups || [];
    const groupStr = groups.join(' ').toLowerCase();
    const hasLoginSignal = groupStr.includes('log-in') || groupStr.includes('login') || groupStr.includes('active');

    if (!hasLoginSignal) {
      return;
    }

    // Record login for today (Romanian time, UTC+2)
    const romanianNow = new Date(Date.now() + 2 * 3600 * 1000);
    const loginDate = romanianNow.toISOString().split('T')[0];

    const { error: loginErr } = await supabase
      .from('daily_logins')
      .upsert({
        user_id: userId,
        login_date: loginDate,
        recorded_at: new Date().toISOString()
      }, { onConflict: 'user_id,login_date' });

    if (loginErr) {
      console.warn('[USER_UPDATE] daily_logins upsert error:', loginErr.message);
    } else {
      console.log(`[USER_UPDATE] ✓ Recorded login for ${user.first_name || userId} on ${loginDate}`);
    }

    // Check if this is a "return after absence" — send welcome-back if inactive 3+ days
    try {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().split('T')[0];
      const { data: recentLogins } = await supabase
        .from('daily_logins')
        .select('login_date')
        .eq('user_id', userId)
        .gt('login_date', threeDaysAgo)
        .order('login_date', { ascending: false });

      // Only 1 login (today's) means they haven't logged in for 3+ days
      if (recentLogins && recentLogins.length <= 1) {
        // Check when Charlie last proactively messaged them
        const { data: studentRecord } = await supabase
          .from('students')
          .select('last_charlie_proactive')
          .eq('heartbeat_id', userId)
          .single();

        const lastProactive = studentRecord?.last_charlie_proactive;
        const daysSinceProactive = lastProactive
          ? Math.floor((Date.now() - new Date(lastProactive).getTime()) / (24 * 3600 * 1000))
          : 999;

        // Only welcome back if Charlie hasn't messaged in 2+ days
        if (daysSinceProactive >= 2) {
          const welcomeBackMsg = await generateWelcomeBack(user);
          if (welcomeBackMsg) {
            await sendSplitMessages(userId, welcomeBackMsg);
            await supabase
              .from('students')
              .upsert({
                heartbeat_id: userId,
                student_id: userId,
                email: user.email || '',
                name: user.name || '',
                last_charlie_proactive: new Date().toISOString()
              }, { onConflict: 'heartbeat_id' });
            console.log(`[USER_UPDATE] Welcome-back sent to ${user.first_name}`);
          }
        }
      }
    } catch (wbErr) {
      console.warn('[USER_UPDATE] Welcome-back check failed:', wbErr.message);
    }

    return;
  } catch (err) {
    console.error('[USER_UPDATE] Handler error:', err.message);
    return;
  }
}

/**
 * Generate a warm welcome-back message for a returning student
 */
async function generateWelcomeBack(user) {
  try {
    const firstName = user.first_name || 'prietene';
    const memberGroups = user.groups || [];
    const groupNames = memberGroups.map(g => typeof g === 'string' ? g : g.name || '').join(', ');

    // Pick 2 lesson suggestions for returning students
    const { pickSuggestedLessons, formatSuggestionsContext } = require('./_lib/suggestions');
    const suggestions = await pickSuggestedLessons(memberGroups);
    const suggestionsContext = formatSuggestionsContext(suggestions, 'reactive');

    const messages = [
      {
        role: 'system',
        content: `Ești Charlie, mentorul personal de engleză la Engleza Britanică (academie pentru vorbitori de română). Ești cald, empatic, ca un prieten bun. Vorbești în română.`
      },
      {
        role: 'user',
        content: `Scrie un mesaj de "bine ai revenit" pentru ${firstName}, care tocmai s-a conectat după câteva zile de absență.
Cursuri/grupuri: ${groupNames || 'student obișnuit'}

${suggestionsContext}

Mesajul trebuie să fie:
- 2-4 propoziții
- Cald și personal, nu generic — zero vinovăție, zero judecată
- Să nu înceapă cu "Bună ziua" sau formule formale
- Dacă menționezi lecții, prezintă-le ca opțiuni ușoare: "mi-ar plăcea să îți arăt X sau Y — spune-mi dacă ești curios/ă"
- Folosește [SPLIT] dacă vrei să trimiți 2 mesaje separate
- Să nu predea engleza, doar să încurajeze și să invite`
      }
    ];
    const { callOpenAI } = require('./_lib/charlie');
    return await callOpenAI(messages);
  } catch (err) {
    console.warn('[generateWelcomeBack] Error:', err.message);
    return null;
  }
}

/**
 * When a student posts a thread in any channel
 * Payload: { id: threadID, channelID }
 * Note: no userID in payload — we fetch thread details to get the author
 */
async function handleThreadCreate(event) {
  try {
    const threadId = event.id;
    const channelId = event.channelID || event.channelId;

    if (!threadId) {
      return;
    }

    console.log(`[THREAD_CREATE] Thread ${threadId} in channel ${channelId}`);

    // Fetch thread details to get author's userID
    let userId = null;
    let channelName = channelId;
    try {
      const { getThread } = require('./_lib/heartbeat');
      const thread = await getThread(threadId);
      userId = thread?.userID || thread?.authorID || thread?.user?.id || null;
      channelName = thread?.channelName || channelId;
    } catch (fetchErr) {
      console.warn('[THREAD_CREATE] Could not fetch thread details:', fetchErr.message);
    }

    if (!userId) {
      console.log('[THREAD_CREATE] Could not determine author — recording without user_id');
      return;
    }

    // Skip Charlie's own posts
    if (userId === CHARLIE_USER_ID) {
      return;
    }

    // Record activity in activity_log
    const romanianNow = new Date(Date.now() + 2 * 3600 * 1000);
    const activityDate = romanianNow.toISOString().split('T')[0];

    await supabase
      .from('activity_log')
      .insert([{
        user_id: userId,
        activity_type: 'POST',
        activity_date: activityDate,
        metadata: { thread_id: threadId, channel_id: channelId, channel_name: channelName }
      }]);

    console.log(`[THREAD_CREATE] ✓ Recorded POST activity for user ${userId} in ${channelName}`);
    return;
  } catch (err) {
    console.error('[THREAD_CREATE] Handler error:', err.message);
    return;
  }
}

/**
 * When a student completes a course
 * Payload: { courseID, courseName, userID }
 */
async function handleCourseCompleted(event) {
  try {
    const userId = event.userID || event.user_id;
    const courseId = event.courseID || event.course_id;
    const courseName = event.courseName || event.course_name || 'un curs';

    if (!userId) {
      return;
    }

    // Skip Charlie's own account
    if (userId === CHARLIE_USER_ID) {
      return;
    }

    console.log(`[COURSE_COMPLETED] User ${userId} completed "${courseName}"`);

    // Record activity in activity_log
    const romanianNow = new Date(Date.now() + 2 * 3600 * 1000);
    const activityDate = romanianNow.toISOString().split('T')[0];

    await supabase
      .from('activity_log')
      .insert([{
        user_id: userId,
        activity_type: 'COURSE_COMPLETE',
        activity_date: activityDate,
        metadata: { course_id: courseId, course_name: courseName }
      }]);

    // Fetch user details for personalised congratulations
    let userName = 'prietene';
    try {
      const { getUserById } = require('./_lib/heartbeat');
      const user = await getUserById(userId);
      userName = user?.first_name || user?.name || 'prietene';
    } catch (e) {}

    // Generate and send congratulations message
    const congratsMsg = await generateCourseCongratsMessage(userName, courseName);
    if (congratsMsg) {
      await sendSplitMessages(userId, congratsMsg);

      // Update last_charlie_proactive timestamp
      await supabase
        .from('students')
        .upsert({
          heartbeat_id: userId,
          student_id: userId,
          last_charlie_proactive: new Date().toISOString()
        }, { onConflict: 'heartbeat_id' });

      console.log(`[COURSE_COMPLETED] ✓ Congratulations sent to ${userName} for "${courseName}"`);
    }

    return;
  } catch (err) {
    console.error('[COURSE_COMPLETED] Handler error:', err.message);
    return;
  }
}

/**
 * Generate a personalised course completion congratulations message
 */
async function generateCourseCongratsMessage(firstName, courseName) {
  try {
    const messages = [
      {
        role: 'system',
        content: `Ești Charlie, mentorul personal de engleză la academia Engleza Britanică. Ești cald, entuziast, ca un prieten bun care sărbătorește cu tine. Vorbești în română.`
      },
      {
        role: 'user',
        content: `${firstName} tocmai a finalizat cursul "${courseName}". Scrie un mesaj SCURT de felicitare:
- Maximum 2-3 propoziții
- Entuziast dar nu exagerat
- Menționează cursul specific
- Încurajează-l să continue cu următorul pas
- Nu fi formal, fii ca un prieten care sărbătorește
- Semnează: "— Charlie 🎉"`
      }
    ];
    return await callOpenAI(messages);
  } catch (err) {
    console.warn('[generateCourseCongratsMessage] Error:', err.message);
    return null;
  }
}

/**
 * Detect student preferences from their message using AI
 * Returns null if no preferences found, otherwise returns a preferences object
 */
/**
 * Search lesson_index for lessons relevant to the student's message.
 * Returns top 3 matching lessons with URLs and learning points.
 */
async function findRelevantLessons(message, supabase) {
  if (!message || message.length < 10) return [];

  const { data: lessons, error } = await supabase
    .from('lesson_index')
    .select('lesson_id, lesson_name, lesson_url, type, week, lesson_number, learning_points')
    .not('lesson_url', 'is', null);

  if (error || !lessons || lessons.length === 0) return [];

  const msgLower = message.toLowerCase();

  const STOP_WORDS = new Set([
    'about','lessons','lesson','any','have','what','tell','with','that','this',
    'from','they','them','their','there','when','where','which','would','could',
    'should','does','been','were','will','more','some','also','into','than',
    'then','just','know','take','make','want','need','like','good','well',
    'think','help','care','used','said','each','these','those','such','here',
    'even','much','same','back','only','most','other','come','over','your',
    'ours','mine','year','work','part','best','long','ways','many','folosesc',
    'poate','pentru','este','sunt','care','unde','cand','daca','cum','vreau',
    'stiu','vrei','avem','asta','acum','deci','deja','dupa','inainte','invatare'
  ]);

  const TOPIC_KEYWORDS = new Set([
    'modal','tense','perfect','passive','conditional','subjunctive',
    'article','preposition','phrasal','collocation','intonation','stress',
    'contraction','gerund','infinitive','participle','reported','indirect',
    'pronunciation','vocabulary','grammar','spelling','idiom','adverb',
    'adjective','determiner','quantifier','relative','clause','conjunction',
    'present','future','continuous','simple','irregular',
    'verb','noun','pronoun','plural','singular','compound','comparative','superlative',
    'auxiliary','negation','question','linking','imperative',
    'obligation','necessity','permission','ability','possibility','probability'
  ]);

  // Concept expansion: specific words that signal a broader grammar topic
  // e.g. asking about "must" → should also match "obligation" lessons
  const CONCEPT_MAP = {
    'must': 'obligation', 'mustn': 'obligation',
    'must not': 'obligation', 'mustnt': 'obligation',
    'have to': 'obligation', 'has to': 'obligation', 'had to': 'obligation',
    'need to': 'obligation', 'needs to': 'obligation',
    'dont have to': 'obligation', 'doesnt have to': 'obligation',
    'should': 'obligation', 'shouldnt': 'obligation', 'ought': 'obligation',
    'can': 'modal', 'cant': 'modal', 'cannot': 'modal',
    'could': 'modal', 'couldnt': 'modal',
    'may': 'modal', 'might': 'modal',
    'will': 'modal', 'wont': 'modal', 'would': 'modal', 'wouldnt': 'modal',
    'allowed': 'permission', 'allow': 'permission', 'permitted': 'permission',
    'able': 'ability', 'ability': 'ability',
    'possible': 'possibility', 'possibly': 'possibility',
    'probably': 'probability', 'probable': 'probability'
  };

  // Romanian grammar terms → English equivalents (for student messages in Romanian)
  const RO_TO_EN = {
    'conjunctii': 'conjunction', 'conjuncții': 'conjunction', 'conjunctie': 'conjunction', 'conjuncție': 'conjunction',
    'timpuri': 'tense', 'timp': 'tense', 'tense': 'tense',
    'prezent': 'present', 'trecut': 'tense', 'viitor': 'future',
    'perfect': 'perfect',
    'continuu': 'continuous', 'continua': 'continuous',
    'modal': 'modal', 'modale': 'modal', 'verbele': 'verb', 'verbe': 'verb',
    'pasiv': 'passive', 'pasiva': 'passive', 'pasivul': 'passive',
    'conditional': 'conditional',
    'articol': 'article', 'articole': 'article', 'articulat': 'article',
    'prepozitie': 'preposition', 'prepoziție': 'preposition', 'prepozitii': 'preposition', 'prepoziții': 'preposition',
    'pronuntie': 'pronunciation', 'pronunție': 'pronunciation', 'pronuntii': 'pronunciation',
    'vocabular': 'vocabulary',
    'gramatica': 'grammar', 'gramatică': 'grammar', 'gramatical': 'grammar',
    'ortografie': 'spelling',
    'idiom': 'idiom', 'idiomuri': 'idiom', 'idiomatic': 'idiom',
    'adverb': 'adverb', 'adverbe': 'adverb',
    'adjectiv': 'adjective', 'adjective': 'adjective',
    'relativ': 'relative', 'relativa': 'relative', 'relativă': 'relative',
    'propozitie': 'clause', 'propoziție': 'clause', 'propozitii': 'clause',
    'gerunziu': 'gerund', 'gerunziu': 'gerund',
    'infinitiv': 'infinitive',
    'participiu': 'participle',
    'vorbire': 'reported', 'indirecta': 'indirect', 'indirectă': 'indirect',
    'contractie': 'contraction', 'contracție': 'contraction', 'contractii': 'contraction',
    'colocatie': 'collocation', 'colocație': 'collocation', 'colocatii': 'collocation',
    'intonatie': 'intonation', 'intonație': 'intonation',
    'accent': 'stress', 'accentul': 'stress',
    'neregulat': 'irregular', 'neregulate': 'irregular', 'neregulata': 'irregular',
    'frazal': 'phrasal', 'frazale': 'phrasal',
    'simplu': 'simple', 'simpla': 'simple', 'simplă': 'simple',
    'obligatie': 'obligation', 'obligație': 'obligation',
    'obligatii': 'obligation', 'obligații': 'obligation',
    'obligatoriu': 'obligation', 'obligatorie': 'obligation',
    'necesitate': 'necessity', 'permisiune': 'permission', 'permisiuni': 'permission',
    'abilitate': 'ability', 'capacitate': 'ability',
    'posibilitate': 'possibility', 'probabilitate': 'probability'
  };

  // Translate Romanian terms to English before scoring
  const rawWords = msgLower
    .split(/[\s,.?!;:()\/]+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .map(w => RO_TO_EN[w] || w);

  // Also check multi-word concept phrases in original message (e.g. "need to", "have to")
  const conceptExpansions = [];
  for (const [phrase, concept] of Object.entries(CONCEPT_MAP)) {
    if (msgLower.includes(phrase)) {
      conceptExpansions.push(concept);
    }
  }

  // Single-word concept lookups (for words like "must", "should", "can")
  const msgWords = [...new Set([
    ...rawWords,
    ...rawWords.map(w => CONCEPT_MAP[w]).filter(Boolean),
    ...conceptExpansions
  ])];

  if (msgWords.length === 0) return [];

  // Build query phrases (pairs of consecutive topic words)
  const phrases = [];
  for (let i = 0; i < msgWords.length - 1; i++) {
    phrases.push(msgWords[i] + ' ' + msgWords[i+1]);
  }

  // Fuzzy-match: "conjunctions" → "conjunction", "modals" → "modal" etc.
  // Returns the canonical topic keyword if this word is a form of one, else null
  function fuzzyTopicMatch(word) {
    if (TOPIC_KEYWORDS.has(word)) return word;
    for (const kw of TOPIC_KEYWORDS) {
      if (word.startsWith(kw) || kw.startsWith(word)) return kw;
    }
    return null;
  }

  const scored = lessons.map(lesson => {
    // Score by DENSITY: how many individual learning points match
    const points = (lesson.learning_points || []).map(p => {
      if (typeof p === 'string') return p.toLowerCase();
      if (typeof p === 'object') return `${p.point || ''} ${p.details || ''}`.toLowerCase();
      return '';
    });

    let totalScore = 0;
    let matchingPoints = 0;

    for (const pt of points) {
      let ptScore = 0;

      for (const word of msgWords) {
        const canonicalTopic = fuzzyTopicMatch(word);
        const ptHasWord = pt.includes(word);
        const ptHasTopic = canonicalTopic && pt.includes(canonicalTopic);

        if (canonicalTopic && (ptHasWord || ptHasTopic)) {
          ptScore += 4; // Topic keyword (or its plural/variant) found in this point
        } else if (ptHasWord) {
          ptScore += 0.5; // Generic exact match
        }
      }
      // Phrase match within a single point (highest quality signal)
      for (const phrase of phrases) {
        if (pt.includes(phrase)) ptScore += 6;
      }

      if (ptScore > 0) matchingPoints++;
      totalScore += ptScore;
    }

    // Bonus: prefer lessons where multiple points match (it's a dedicated lesson on this topic)
    if (matchingPoints >= 2) totalScore += matchingPoints * 2;
    // Bonus: lessons with a week number are structured course lessons
    if (lesson.week) totalScore += 1;
    // Strong bonus: lesson NAME contains query keywords (lesson is specifically about this topic)
    const lessonNameLower = (lesson.lesson_name || '').toLowerCase();
    for (const word of msgWords) {
      const canonical = fuzzyTopicMatch(word) || word;
      if (lessonNameLower.includes(word) || lessonNameLower.includes(canonical)) {
        totalScore += 20; // Lesson is explicitly about this topic
      }
    }
    // Grammar type bonus when query has grammar-related keywords
    const grammarQuery = msgWords.some(w => fuzzyTopicMatch(w) !== null);
    if (grammarQuery && lesson.type === 'Grammar') {
      totalScore += 5;
    }

    return { ...lesson, score: Math.round(totalScore) };
  });

  // CRITICAL: Only return lessons if student is asking about a TOPIC
  // (grammar, vocabulary, pronunciation, idioms, etc.)
  // Otherwise, Charlie shouldn't recommend lessons for casual messages like "hey, how are you?"
  const hasTopic = msgWords.some(w => fuzzyTopicMatch(w) !== null);
  
  if (!hasTopic) return []; // No lessons unless student asks about something substantive

  return scored
    .filter(l => l.score >= 6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

/**
 * Build lesson context string to inject into Charlie's system prompt.
 */
function buildLessonContext(lessons) {
  if (!lessons || lessons.length === 0) return '';

  // Map week ranges to course names for breadcrumb
  const weekToCourse = w => {
    if (w >= 1 && w <= 13) return 'Baza Solidă';
    if (w >= 14 && w <= 26) return 'Exprimare Clară';
    if (w >= 27 && w <= 39) return 'Idei Legate';
    if (w >= 40 && w <= 51) return 'Engleza Reală';
    return '';
  };

  const lines = lessons.map(lesson => {
    const url = lesson.lesson_url || '';
    const name = lesson.lesson_name || '';
    const week = lesson.week;
    const course = week ? weekToCourse(week) : '';

    // Breadcrumb: "Week 23 — Baza Solidă"
    const breadcrumb = [week ? `Week ${week}` : '', course].filter(Boolean).join(' — ');

    // Extract readable learning points
    const pts = (lesson.learning_points || []).slice(0, 4).map(p => {
      if (typeof p === 'string') return p;
      if (typeof p === 'object' && p.point) return p.point + (p.details ? ': ' + p.details.substring(0, 80) : '');
      return '';
    }).filter(Boolean);

    // Link uses lesson name as text (not generic "deschide lecția")
    const linkHtml = url && name ? `<a href="${url}">${name}</a>` : (url ? `<a href="${url}">deschide lecția</a>` : '');

    return `📚 ${name}${breadcrumb ? ` (${breadcrumb})` : ''}\n` +
      `  🔗 Link: ${linkHtml}\n` +
      (pts.length ? `  Acoperă:\n` + pts.slice(0, 3).map(p => `  • ${p}`).join('\n') : '');
  });

  return `LECȚII RELEVANTE GĂSITE — FOLOSEȘTE ACESTE URL-URI EXACTE:
Acestea sunt lecțiile reale din academie care acoperă subiectul întrebării studentului.

REGULI DE FORMATARE:
- Folosește URL-ul EXACT de mai jos — nu îl modifica niciodată
- ⚠️ Format link OBLIGATORIU: <a href="URL_EXACT">Numele Lecției</a> — linkul trebuie să aibă NUMELE LECȚIEI ca text, nu "deschide lecția"
- Când recomanzi activ o lecție, menționează 1-2 lucruri specifice pe care le acoperă (din lista "Acoperă" de mai jos) — face recomandarea să pară concretă și utilă
- Când menționezi lecția în treacăt, folosește doar linkul cu numele
- Adaugă breadcrumb-ul (ex: "Week 23 — Baza Solidă") ca context de orientare
- NU inventa titluri de lecții sau URL-uri noi

${lines.join('\n\n')}`
}

async function detectPreferences(messageText) {
  const detectionMessages = [
    {
      role: 'system',
      content: `You are a preference extractor. Analyze the student's message and extract any explicit preferences or instructions they are giving about how they want to be contacted or mentored. 
      
Return a JSON object with ONLY the preferences that are explicitly stated. Use null for preferences not mentioned.

Valid fields:
- always_checkin: true (they want daily morning messages) / false (they don't want proactive messages)
- no_weekends: true (don't contact on weekends)
- away_until: "YYYY-MM-DD" (they'll be away until this date) / null
- preferred_language: "english" or "romanian" (their preferred language for Charlie's messages)
- focus_area: one of "pronunciation", "vocabulary", "grammar", "speaking", "listening", "reading" 
- goal: string (their stated learning goal e.g. "IELTS by June", "job interview in March")
- no_morning_messages: true (they explicitly don't want morning messages)

IMPORTANT: Only extract what is EXPLICITLY stated. Do not infer. If the message contains no preferences, return {"has_preferences": false}.
If preferences found, return {"has_preferences": true, "preferences": {...}}

Examples:
- "Scrie-mi în fiecare dimineață" → {"has_preferences": true, "preferences": {"always_checkin": true}}
- "Sunt în vacanță 2 săptămâni" (today is 2026-03-11) → {"has_preferences": true, "preferences": {"away_until": "2026-03-25"}}
- "Nu mă deranja în weekend" → {"has_preferences": true, "preferences": {"no_weekends": true}}
- "Vreau să mă concentrez pe pronunție" → {"has_preferences": true, "preferences": {"focus_area": "pronunciation"}}
- "Scrie-mi în engleză" → {"has_preferences": true, "preferences": {"preferred_language": "english"}}
- "Obiectivul meu e IELTS în iunie" → {"has_preferences": true, "preferences": {"goal": "IELTS in June"}}
- "Nu mai trimite mesaje dimineața" → {"has_preferences": true, "preferences": {"no_morning_messages": true}}
- "Cum merg lecțiile?" → {"has_preferences": false}`
    },
    {
      role: 'user',
      content: `Today's date: ${new Date().toISOString().split('T')[0]}\n\nStudent message: "${messageText}"\n\nExtract preferences as JSON:`
    }
  ];

  const result = await callOpenAI(detectionMessages, { response_format: { type: 'json_object' }, max_tokens: 300 });
  
  try {
    const parsed = JSON.parse(result);
    if (!parsed.has_preferences) return null;
    return parsed.preferences || null;
  } catch (e) {
    return null;
  }
}

/**
 * Merge new preferences with existing ones and save to students table
 */
async function savePreferences(studentId, newPrefs) {
  // Get current preferences
  const { data: current } = await supabase
    .from('students')
    .select('preferences')
    .eq('heartbeat_id', studentId)
    .single();

  const existingPrefs = current?.preferences || {};
  const mergedPrefs = { ...existingPrefs, ...newPrefs, last_updated: new Date().toISOString() };

  await supabase
    .from('students')
    .upsert({
      heartbeat_id: studentId,
      student_id: studentId,
      preferences: mergedPrefs
    }, { onConflict: 'heartbeat_id' });
}

/**
 * Build a context note for Charlie to acknowledge detected preferences naturally
 */
function buildPreferencesContext(prefs) {
  const notes = [];
  if (prefs.always_checkin === true) notes.push('The student just asked you to message them every morning. Acknowledge this warmly and confirm you will.');
  if (prefs.no_morning_messages === true) notes.push('The student just asked you NOT to send morning messages. Acknowledge this and confirm you understand.');
  if (prefs.no_weekends === true) notes.push('The student asked you not to contact them on weekends. Acknowledge this.');
  if (prefs.away_until) notes.push(`The student mentioned they will be away until ${prefs.away_until}. Acknowledge this warmly and say you will be here when they return.`);
  if (prefs.preferred_language === 'english') notes.push('The student just asked you to write to them in English. Switch to English for your response.');
  if (prefs.preferred_language === 'romanian') notes.push('The student just asked you to write in Romanian. Confirm you will.');
  if (prefs.focus_area) notes.push(`The student wants to focus on ${prefs.focus_area}. Acknowledge this and briefly affirm it is a great focus area.`);
  if (prefs.goal) notes.push(`The student shared their goal: "${prefs.goal}". Acknowledge this goal warmly.`);
  
  if (notes.length === 0) return '';
  return `IMPORTANT — the student's message contains a personal preference or instruction. ${notes.join(' ')} Make sure your response acknowledges this naturally without being robotic.`;
}


/**
 * Track when a student messages — records sessions (not individual messages)
 * A session = a conversation window; messages within 60 min of each other count as one session
 * Stores last 20 session hours and derives active_window (morning/afternoon/evening)
 */
async function trackMessageSession(studentId) {
  try {
    const romanianNow = new Date(Date.now() + 2 * 3600 * 1000); // UTC+2 (Romanian time)
    const currentHour = romanianNow.getHours();
    const currentTime = Date.now();

    // Fetch current preferences
    const { data: rec } = await supabase
      .from('students')
      .select('preferences')
      .eq('heartbeat_id', studentId)
      .single();

    const prefs = rec?.preferences || {};
    const lastSessionAt = prefs._last_session_at ? new Date(prefs._last_session_at).getTime() : 0;
    const sessionHours = Array.isArray(prefs._session_hours) ? prefs._session_hours : [];

    // Same session if within 60 minutes of last recorded session — skip
    if (currentTime - lastSessionAt < 60 * 60 * 1000) {
      return;
    }

    // New session — add hour and keep last 20
    const updatedHours = [...sessionHours, currentHour].slice(-20);

    // Derive active_window once we have 5+ sessions
    let activeWindow = prefs.active_window || 'morning'; // default morning
    if (updatedHours.length >= 5) {
      const morning   = updatedHours.filter(h => h >= 6 && h < 12).length;
      const afternoon = updatedHours.filter(h => h >= 12 && h < 18).length;
      const evening   = updatedHours.filter(h => h >= 18 || h < 6).length;
      const maxCount  = Math.max(morning, afternoon, evening);
      if (maxCount === morning) activeWindow = 'morning';
      else if (maxCount === afternoon) activeWindow = 'afternoon';
      else activeWindow = 'evening';
    }

    const newPrefs = {
      ...prefs,
      _session_hours: updatedHours,
      _last_session_at: new Date().toISOString(),
      active_window: activeWindow
    };

    await supabase
      .from('students')
      .upsert({
        heartbeat_id: studentId,
        student_id: studentId,
        preferences: newPrefs
      }, { onConflict: 'heartbeat_id' });

    console.log(`[Session] New session at hour ${currentHour} RO time for ${studentId}. Window: ${activeWindow} (${updatedHours.length} sessions recorded)`);
  } catch (err) {
    console.warn('[trackMessageSession] Non-fatal error:', err.message);
  }
}

/**
 * When a student joins a course
 */
async function handleGroupJoin(event) {
  try {
    const userId = event.userID || event.user_id;
    const userName = event.fullName || event.name || event.user_name || 'student';
    const groupName = event.groupName || event.group_name || event.name || 'curs nou';

    console.log(`[GROUP_JOIN] ${userName} joined "${groupName}"`);

    const courseMsg = await callOpenAI([
      {
        role: 'system',
        content: 'Ești Charlie, mentorul personal de engleză la academia Engleza Britanică. Ești cald, entuziast, ca un prieten bun. Vorbești în română. Poți folosi [SPLIT] pentru mesaje separate.'
      },
      {
        role: 'user',
        content: `${userName} tocmai s-a înscris la cursul "${groupName}". Scrie un mesaj scurt și natural de încurajare — 2-3 propoziții max. Menționează cursul. Spune că ești acolo dacă are nevoie. Poți folosi [SPLIT] dacă vrei să trimiți 2 mesaje scurte în loc de unul. Fii sincer și cald, nu exagerat de entuziast.`
      }
    ]);
    await sendSplitMessages(userId, courseMsg);

    console.log('[GROUP_JOIN] Message sent to', userName);
    return;
  } catch (err) {
    console.error('[GROUP_JOIN] Handler error:', err.message);
    return;
  }
}
