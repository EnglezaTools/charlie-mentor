const { sendDirectMessage } = require('./_lib/heartbeat');
const { findUser } = require('./_lib/heartbeat');
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
    
    console.log('[Webhook] Event received:', event.type);

    // Handle different event types
    switch (event.type) {
      case 'DIRECT_MESSAGE':
        return await handleDirectMessage(event, res);
      
      case 'USER_JOIN':
        return await handleUserJoin(event, res);
      
      case 'GROUP_JOIN':
        return await handleGroupJoin(event, res);
      
      default:
        console.log('[Webhook] Unknown event type:', event.type);
        return res.status(200).json({ handled: false });
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
    const { sender_id, sender_name, content } = event;

    // Don't respond to our own messages
    if (sender_id === CHARLIE_USER_ID) {
      return res.status(200).json({ handled: true, skipped: true });
    }

    console.log(`[DM] Message from ${sender_name}: "${content}"`);

    // Get student profile from cache/API
    const student = await findUser(event.sender_email || sender_name);
    const studentId = student?.heartbeat_id || sender_id;

    // Build context
    const systemPrompt = await buildSystemPrompt(studentId);
    
    // Get Charlie's response
    const response = await callOpenAI([
      { role: 'system', content: systemPrompt },
      { role: 'user', content }
    ]);

    // Send response back to student
    await sendDirectMessage(sender_id, response);

    // Store conversation
    await supabase
      .from('conversations')
      .insert([{
        student_id: studentId,
        user_message: content,
        charlie_response: response,
        context: JSON.stringify({ event_type: 'DIRECT_MESSAGE' })
      }]);

    console.log('[DM] Responded to', sender_name);
    return res.status(200).json({ handled: true, responded: true });
  } catch (err) {
    console.error('[DM] Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * When a new student joins the community
 */
async function handleUserJoin(event, res) {
  try {
    const { user_id, user_name, user_email } = event;

    console.log(`[USER_JOIN] ${user_name} joined`);

    // Get their profile to understand their goals
    const student = await findUser(user_email || user_name);
    const studentId = student?.heartbeat_id || user_id;
    const onboarding = student?.onboarding_responses || {};

    // Build welcome message
    let welcomeMsg = `Salut ${user_name}! 👋 Eu sunt Charlie, mentorul tău de engleză.\n\n`;
    welcomeMsg += `Sunt aici să te ghidez pe parcursul acestui curs, să te motivez și să te ajut să rămâi concentrat pe obiectivele tale.\n\n`;
    welcomeMsg += `Nu mă va privi pentru răspunsuri directe la întrebări de engleză - pentru acelea mergem la resurse dedicate.\n\n`;
    welcomeMsg += `Dar pentru orice alt lucru - progres, dificultăți, motivație, ghidare - sunt aici pentru tine. Hai, ce spui - gata să începem? 🚀`;

    // Send welcome
    await sendDirectMessage(user_id, welcomeMsg);

    // Store in database
    await supabase
      .from('students')
      .upsert({
        student_id: studentId,
        heartbeat_id: user_id,
        email: user_email || '',
        name: user_name,
        onboarding_responses: onboarding,
        last_interaction: new Date().toISOString()
      }, { onConflict: 'student_id' });

    console.log('[USER_JOIN] Welcome sent to', user_name);
    return res.status(200).json({ handled: true, welcomed: true });
  } catch (err) {
    console.error('[USER_JOIN] Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * When a student joins a course
 */
async function handleGroupJoin(event, res) {
  try {
    const { user_id, user_name, group_name, group_id } = event;

    console.log(`[GROUP_JOIN] ${user_name} joined "${group_name}"`);

    // Get student record
    const student = await findUser(user_name);
    const studentId = student?.heartbeat_id || user_id;

    // Build course-start message
    const courseMsg = `Bun venit în "${group_name}"! 🎓\n\nAcum că ai intrat în curs, voi fi aici să te ajut să ai succes.\n\nAre vreo îngrijorare, întrebare despre progres, sau ai nevoie de motivație? Scrie-mi! 💪`;

    await sendDirectMessage(user_id, courseMsg);

    console.log('[GROUP_JOIN] Message sent to', user_name);
    return res.status(200).json({ handled: true, notified: true });
  } catch (err) {
    console.error('[GROUP_JOIN] Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
