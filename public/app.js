/* ── Charlie — Frontend App ─────────────────────────────────── */

const API = '';  // same origin
let studentToken = null;
let studentName  = null;
let isSending    = false;

// ── Init ──────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  studentToken = localStorage.getItem('charlie_token');
  studentName  = localStorage.getItem('charlie_name');

  // Check for URL parameter (for Heartbeat embedding)
  const urlParams = new URLSearchParams(window.location.search);
  const emailParam = urlParams.get('email') || urlParams.get('student');

  if (studentToken) {
    showChat();
    loadHistory();
  } else if (emailParam) {
    // Auto-authenticate with URL parameter
    autoAuthenticateWithEmail(emailParam);
  } else {
    showLogin();
  }
});

// ── Auto-Auth (for Heartbeat embedding) ────────────────────────

async function autoAuthenticateWithEmail(email) {
  const loginBtn = document.getElementById('login-btn');
  if (loginBtn) loginBtn.disabled = true;

  try {
    const resp = await fetch(`${API}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() })
    });

    const data = await resp.json();

    if (!resp.ok || !data.found) {
      // Auto-auth failed, show login form
      showLogin();
      return;
    }

    // Success
    studentToken = data.token;
    studentName  = data.name;
    localStorage.setItem('charlie_token', studentToken);
    localStorage.setItem('charlie_name', studentName);

    showChat();
    loadHistory();

  } catch (err) {
    // Auto-auth failed, show login form
    console.error('[Auto-Auth] Error:', err);
    showLogin();
  }
}

// ── Screens ───────────────────────────────────────────────────

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('chat-screen').classList.add('hidden');
  setTimeout(() => document.getElementById('email-input')?.focus(), 100);
}

function showChat() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('chat-screen').classList.remove('hidden');
  setTimeout(() => document.getElementById('message-input')?.focus(), 100);
}

// ── Login ─────────────────────────────────────────────────────

async function handleLogin() {
  const emailInput = document.getElementById('email-input');
  const loginBtn   = document.getElementById('login-btn');
  const errorDiv   = document.getElementById('login-error');
  const email      = emailInput.value.trim();

  errorDiv.classList.add('hidden');
  errorDiv.textContent = '';

  if (!email || !email.includes('@')) {
    showError('Te rugăm să introduci o adresă de email validă.');
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = 'Se verifică...';

  try {
    const resp = await fetch(`${API}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const data = await resp.json();

    if (!resp.ok) {
      showError(data.detail || 'A apărut o eroare. Te rugăm să încerci din nou.');
      return;
    }

    if (!data.found) {
      showError(data.message || 'Emailul nu a fost găsit în academie.');
      return;
    }

    // Success
    studentToken = data.token;
    studentName  = data.name;
    localStorage.setItem('charlie_token', studentToken);
    localStorage.setItem('charlie_name', studentName);

    showChat();
    loadHistory();

  } catch (err) {
    showError('Nu s-a putut conecta la server. Încearcă din nou.');
    console.error('[Login] Error:', err);
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Începe';
  }
}

function showError(msg) {
  const errorDiv = document.getElementById('login-error');
  errorDiv.textContent = msg;
  errorDiv.classList.remove('hidden');
}

// ── Logout ────────────────────────────────────────────────────

function handleLogout() {
  if (!confirm('Ești sigur că vrei să te deconectezi?')) return;
  localStorage.removeItem('charlie_token');
  localStorage.removeItem('charlie_name');
  studentToken = null;
  studentName  = null;
  document.getElementById('messages-list').innerHTML = '';
  showLogin();
}

// ── Load History ──────────────────────────────────────────────

async function loadHistory() {
  try {
    const resp = await fetch(`${API}/api/history?token=${encodeURIComponent(studentToken)}`);
    if (!resp.ok) {
      // Token invalid — force logout
      handleLogout();
      return;
    }

    const data = await resp.json();

    if (data.first_name) {
      studentName = data.first_name;
      localStorage.setItem('charlie_name', studentName);
    }

    const msgs = data.messages || [];

    if (msgs.length === 0) {
      // No history — trigger greeting
      sendGreeting();
    } else {
      // Render existing messages
      const list = document.getElementById('messages-list');
      list.innerHTML = '';
      msgs.forEach(m => appendMessage(m.role, m.content, false));
      scrollToBottom();
    }

  } catch (err) {
    console.error('[History] Error:', err);
    sendGreeting();
  }
}

// ── Greeting ──────────────────────────────────────────────────

async function sendGreeting() {
  await sendMessage('__GREETING__', true);
}

// ── Send Message ──────────────────────────────────────────────

async function handleSend() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();

  if (!text || isSending) return;

  input.value = '';
  autoResize(input);
  await sendMessage(text, false);
}

function handleKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSend();
  }
}

async function sendMessage(text, isGreeting) {
  if (isSending) return;
  isSending = true;

  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) sendBtn.disabled = true;

  // Show user message (not for greeting)
  if (!isGreeting) {
    appendMessage('user', text, true);
  }

  // Show typing indicator
  showTyping(true);
  scrollToBottom();

  try {
    const resp = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: studentToken, message: text })
    });

    showTyping(false);

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      if (resp.status === 401) {
        appendMessage('assistant', 'Sesiunea ta a expirat. Te rugăm să te autentifici din nou.', true);
        setTimeout(handleLogout, 2000);
      } else {
        appendMessage('assistant', `Ne pare rău, a apărut o eroare: ${err.detail || 'necunoscută'}. Încearcă din nou.`, true);
      }
      return;
    }

    const data = await resp.json();
    appendMessage('assistant', data.reply, true);

  } catch (err) {
    showTyping(false);
    appendMessage('assistant', 'Nu s-a putut trimite mesajul. Verifică conexiunea și încearcă din nou.', true);
    console.error('[Chat] Error:', err);
  } finally {
    isSending = false;
    if (sendBtn) sendBtn.disabled = false;
    scrollToBottom();
    document.getElementById('message-input')?.focus();
  }
}

// ── UI Helpers ────────────────────────────────────────────────

function appendMessage(role, content, animate) {
  const list = document.getElementById('messages-list');
  
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;
  if (!animate) wrapper.style.animation = 'none';

  if (role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'charlie-avatar tiny';
    avatar.textContent = 'C';
    wrapper.appendChild(avatar);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;

  wrapper.appendChild(bubble);
  list.appendChild(wrapper);

  if (animate) scrollToBottom();
}

function showTyping(show) {
  const indicator = document.getElementById('typing-indicator');
  if (show) {
    indicator.classList.remove('hidden');
  } else {
    indicator.classList.add('hidden');
  }
}

function scrollToBottom() {
  const area = document.getElementById('messages-area');
  if (area) {
    setTimeout(() => {
      area.scrollTop = area.scrollHeight;
    }, 50);
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
