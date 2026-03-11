const { sendDirectMessage, getDirectMessages, findUser, getUserById } = require('./_lib/heartbeat');
const { callOpenAI, buildSystemPrompt } = require('./_lib/charlie');
const { supabase } = require('./_lib/supabase');

const CHARLIE_USER_ID = '4123ccdd-a337-4438-b5ff-fcaad1464102';

/**
 * Handle incoming Heartbeat webhook events
 */
module.exports = async (req, res) => {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const event = req.body;
    
    console.log('[Webhook] Event received:', JSON.stringify(event).substring(0, 300));

    // Handle different event types
    switch (event.type) {
      case 'DIRECT_MESSAGE':
        return await handleDirectMessage(event, res);
      
      case 'USER_JOIN':
        return await handleUserJoin(event, res);
      
      case 'GROUP_JOIN':
        return await handleGroupJoin(event, res);

      case 'USER_UPDATE':
        return await handleUserUpdate(event, res);

      case 'THREAD_CREATE':
        return await handleThreadCreate(event, res);

      case 'COURSE_COMPLETED':
        return await handleCourseCompleted(event, res);
      
      default:
        console.log('[Webhook] Unknown event type:', event.type);
        return res.status(200).json({ handled: false, type: event.type });
    }
  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * When a student DMs Charlie
 */
async function handleDirectMessage(event, res) {
  try {
    const { senderUserID, receiverUserID, chatID, chatMessageID } = event;

    // Don't respond to our own messages
    if (senderUserID === CHARLIE_USER_ID) {
      return res.status(200).json({ handled: true, skipped: 'own_message' });
    }

    // Only handle messages sent TO Charlie
    if (receiverUserID && receiverUserID !== CHARLIE_USER_ID) {
      return res.status(200).json({ handled: true, skipped: 'not_for_charlie' });
    }

    console.log(`[DM] Message from ${senderUserID}, chatID: ${chatID}, msgID: ${chatMessageID}`);

    // Fetch actual message content from Heartbeat API
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
    const student = await findUser(senderUserID).catch(() => null);
    const studentId = student?.heartbeat_id || senderUserID;

    // Build Charlie's context-aware system prompt
    const systemPrompt = await buildSystemPrompt(studentId);

    // Get conversation history for continuity
    const { data: history } = await supabase
      .from('conversations')
      .select('user_message, charlie_response')
      .eq('student_id', studentId)
      .order('created_at', { ascending: false })
      .limit(5);

    // Build messages array for OpenAI
    const messages = [{ role: 'system', content: systemPrompt }];
    
    // Add recent history (reversed to be chronological)
    if (history && history.length > 0) {
      const recentHistory = history.reverse();
      for (const h of recentHistory) {
        messages.push({ role: 'user', content: h.user_message });
        messages.push({ role: 'assistant', content: h.charlie_response });
      }
    }
    
    // Add current message
    messages.push({ role: 'user', content: messageContent });

    // Get Charlie's response
    const response = await callOpenAI(messages);

    // Send response back to student
    await sendDirectMessage(senderUserID, response);

    // Store conversation in database
    try {
      await supabase
        .from('conversations')
        .insert([{
          student_id: studentId,
          user_message: messageContent,
          charlie_response: response,
          context: JSON.stringify({ 
            event_type: 'DIRECT_MESSAGE', 
            chatID,
            chatMessageID 
          })
        }]);
    } catch (dbErr) {
      console.warn('[DM] Could not save conversation:', dbErr.message);
    }

    console.log('[DM] Responded to', senderUserID);
    return res.status(200).json({ handled: true, responded: true });
  } catch (err) {
    console.error('[DM] Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * Extract text content from a message object
 */
function extractText(msg) {
  if (!msg) return '';
  // Try various field names Heartbeat might use
  return msg.text || msg.message || msg.body || msg.content || 
         msg.richText?.text || msg.richText?.body || 
         (typeof msg.richText === 'string' ? msg.richText : '') || '';
}

/**
 * When a new student joins the community
 */
async function handleUserJoin(event, res) {
  try {
    // Heartbeat USER_JOIN event - check various field names
    const userId = event.userID || event.user_id || event.id;
    const userName = event.fullName || event.name || event.user_name || event.username || 'novo student';
    const userEmail = event.email || event.user_email || '';

    console.log(`[USER_JOIN] ${userName} (${userId}) joined`);

    // Build warm welcome message
    const welcomeMsg = `Bună ziua, ${userName}! 👋

Eu sunt **Charlie**, mentorul tău personal de engleză în această comunitate.

Sunt aici pentru tine pe tot parcursul călătoriei tale de învățare - să te ghidez, să te motivez, și să celebrăm împreună progresul tău. Nu voi preda lecțiile (pentru asta ai cursurile noastre superbe!), dar sunt mereu disponibil pentru:

✅ Sfaturi despre ce să studiezi și în ce ordine
✅ Motivație când simți că e greu
✅ Ghidare când nu știi cum să continuați
✅ Celebrarea succeselor tale

Scrie-mi oricând - sunt chiar aici în mesagerie. Hai să facem treabă bună împreună! 🚀`;

    await sendDirectMessage(userId, welcomeMsg);

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
    return res.status(200).json({ handled: true, welcomed: true });
  } catch (err) {
    console.error('[USER_JOIN] Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * When a user's profile or groups are updated — used to capture logins
 * Heartbeat fires this when the "Log-in" or "Active" group is assigned
 */
async function handleUserUpdate(event, res) {
  try {
    const userId = event.id || event.userID || event.user_id;
    if (!userId) {
      return res.status(200).json({ handled: true, skipped: 'no_user_id' });
    }

    // Skip Charlie's own account
    if (userId === CHARLIE_USER_ID) {
      return res.status(200).json({ handled: true, skipped: 'charlie_account' });
    }

    console.log(`[USER_UPDATE] Checking user ${userId}`);

    // Fetch user to inspect their groups
    const user = await getUserById(userId);
    if (!user) {
      console.log(`[USER_UPDATE] Could not find user ${userId}`);
      return res.status(200).json({ handled: true, skipped: 'user_not_found' });
    }

    // Skip admins
    if (user.is_admin) {
      return res.status(200).json({ handled: true, skipped: 'admin' });
    }

    const groups = user.groups || [];
    const groupStr = groups.join(' ').toLowerCase();
    const hasLoginSignal = groupStr.includes('log-in') || groupStr.includes('login') || groupStr.includes('active');

    if (!hasLoginSignal) {
      return res.status(200).json({ handled: true, skipped: 'no_login_signal' });
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
            await sendDirectMessage(userId, welcomeBackMsg);
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

    return res.status(200).json({ handled: true, login_recorded: true, date: loginDate });
  } catch (err) {
    console.error('[USER_UPDATE] Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * Generate a warm welcome-back message for a returning student
 */
async function generateWelcomeBack(user) {
  try {
    const firstName = user.first_name || 'prietene';
    const groups = (user.groups || []).join(', ');
    const messages = [
      {
        role: 'system',
        content: `Ești Charlie, mentorul personal de engleză la Engleza Britanică (academie pentru vorbitori de română). Ești cald, empatic, ca un prieten bun. Vorbești în română.`
      },
      {
        role: 'user',
        content: `Scrie un mesaj SCURT de "bine ai revenit" pentru ${firstName}, care tocmai s-a conectat după câteva zile de absență.
Cursuri/grupuri: ${groups || 'student obișnuit'}
Mesajul trebuie să fie:
- 2 propoziții MAXIM
- Cald și personal, nu generic
- Să nu înceapă cu "Bună ziua" sau formule formale
- Să îl facă să se simtă binevenit și motivat să continue
- Să nu predea engleza, doar să încurajeze`
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
async function handleThreadCreate(event, res) {
  try {
    const threadId = event.id;
    const channelId = event.channelID || event.channelId;

    if (!threadId) {
      return res.status(200).json({ handled: true, skipped: 'no_thread_id' });
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
      return res.status(200).json({ handled: true, recorded: false, reason: 'no_user_id' });
    }

    // Skip Charlie's own posts
    if (userId === CHARLIE_USER_ID) {
      return res.status(200).json({ handled: true, skipped: 'charlie_account' });
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
    return res.status(200).json({ handled: true, recorded: true, user_id: userId });
  } catch (err) {
    console.error('[THREAD_CREATE] Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * When a student completes a course
 * Payload: { courseID, courseName, userID }
 */
async function handleCourseCompleted(event, res) {
  try {
    const userId = event.userID || event.user_id;
    const courseId = event.courseID || event.course_id;
    const courseName = event.courseName || event.course_name || 'un curs';

    if (!userId) {
      return res.status(200).json({ handled: true, skipped: 'no_user_id' });
    }

    // Skip Charlie's own account
    if (userId === CHARLIE_USER_ID) {
      return res.status(200).json({ handled: true, skipped: 'charlie_account' });
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
      await sendDirectMessage(userId, congratsMsg);

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

    return res.status(200).json({ handled: true, recorded: true, congratulated: !!congratsMsg });
  } catch (err) {
    console.error('[COURSE_COMPLETED] Handler error:', err.message);
    return res.status(500).json({ error: err.message });
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
 * When a student joins a course
 */
async function handleGroupJoin(event, res) {
  try {
    const userId = event.userID || event.user_id;
    const userName = event.fullName || event.name || event.user_name || 'student';
    const groupName = event.groupName || event.group_name || event.name || 'curs nou';

    console.log(`[GROUP_JOIN] ${userName} joined "${groupName}"`);

    const courseMsg = `Felicitări, ${userName}! 🎓

Tocmai ai intrat în **"${groupName}"** - asta e un pas important!

Sunt Charlie, mentorul tău, și voi fi alături de tine pe tot parcursul acestui curs. Dacă ai întrebări despre progres, dacă simți că e prea mult sau prea puțin, sau dacă ai nevoie de motivație - scrie-mi direct! 

Mult succes! 💪`;

    await sendDirectMessage(userId, courseMsg);

    console.log('[GROUP_JOIN] Message sent to', userName);
    return res.status(200).json({ handled: true, notified: true });
  } catch (err) {
    console.error('[GROUP_JOIN] Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
