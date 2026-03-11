const { supabase } = require('./supabase');

const HEARTBEAT_BASE = 'https://api.heartbeat.chat/v0';
const HEARTBEAT_API_KEY = process.env.HEARTBEAT_API_KEY;

function headers() {
  return {
    'Authorization': `Bearer ${HEARTBEAT_API_KEY}`,
    'Content-Type': 'application/json'
  };
}

/**
 * Find a user in Heartbeat by email, fallback to local cache
 */
async function findUser(email) {
  // Try Heartbeat API first
  try {
    const resp = await fetch(`${HEARTBEAT_BASE}/users?search=${encodeURIComponent(email)}`, {
      headers: headers()
    });

    if (resp.ok) {
      const data = await resp.json();
      const users = data.data || data.users || data || [];
      const arr = Array.isArray(users) ? users : [];

      for (const u of arr) {
        const uEmail = (u.email || '').toLowerCase().trim();
        if (uEmail === email.toLowerCase().trim()) {
          return {
            heartbeat_id: u.id || u._id || null,
            name: u.name || u.display_name || '',
            first_name: (u.name || u.display_name || '').split(' ')[0],
            email: u.email,
            bio: u.bio || u.description || '',
            groups: u.groups || u.badges || [],
            onboarding_responses: u.onboarding_responses || u.onboarding || {}
          };
        }
      }
    }
  } catch (err) {
    console.error('[Heartbeat] API search failed:', err.message);
  }

  // Fallback: check local cache
  try {
    const { data: cache } = await supabase
      .from('community_cache')
      .select('value')
      .eq('key', 'members')
      .single();

    if (cache && cache.value) {
      const members = Array.isArray(cache.value) ? cache.value : [];
      const found = members.find(m =>
        (m.email || '').toLowerCase().trim() === email.toLowerCase().trim()
      );
      if (found) {
        return {
          heartbeat_id: found.id || found._id || null,
          name: found.name || found.display_name || '',
          first_name: (found.name || found.display_name || '').split(' ')[0],
          email: found.email,
          bio: found.bio || found.description || '',
          groups: found.groups || found.badges || [],
          onboarding_responses: found.onboarding_responses || found.onboarding || {}
        };
      }
    }
  } catch (err) {
    console.error('[Heartbeat] Cache lookup failed:', err.message);
  }

  return null;
}

/**
 * Sync all data from Heartbeat into community_cache
 */
async function syncAll() {
  const results = { channels: 0, courses: 0, members: 0, errors: [] };

  // Sync channels
  try {
    const resp = await fetch(`${HEARTBEAT_BASE}/channels`, { headers: headers() });
    if (resp.ok) {
      const data = await resp.json();
      const channels = data.data || data.channels || data || [];
      await supabase
        .from('community_cache')
        .upsert({ key: 'channels', value: channels, updated_at: new Date().toISOString() });
      results.channels = Array.isArray(channels) ? channels.length : 0;
    }
  } catch (err) {
    results.errors.push(`channels: ${err.message}`);
  }

  // Sync courses
  try {
    const resp = await fetch(`${HEARTBEAT_BASE}/courses`, { headers: headers() });
    if (resp.ok) {
      const data = await resp.json();
      const courses = data.data || data.courses || data || [];
      await supabase
        .from('community_cache')
        .upsert({ key: 'courses', value: courses, updated_at: new Date().toISOString() });
      results.courses = Array.isArray(courses) ? courses.length : 0;
    }
  } catch (err) {
    results.errors.push(`courses: ${err.message}`);
  }

  // Sync members (paginated)
  try {
    let allMembers = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const resp = await fetch(`${HEARTBEAT_BASE}/users?page=${page}&per_page=100`, {
        headers: headers()
      });

      if (!resp.ok) break;

      const data = await resp.json();
      const users = data.data || data.users || data || [];
      const arr = Array.isArray(users) ? users : [];

      allMembers = allMembers.concat(arr);

      if (arr.length < 100) {
        hasMore = false;
      } else {
        page++;
        if (page > 50) break; // safety limit
      }
    }

    await supabase
      .from('community_cache')
      .upsert({ key: 'members', value: allMembers, updated_at: new Date().toISOString() });
    results.members = allMembers.length;
  } catch (err) {
    results.errors.push(`members: ${err.message}`);
  }

  return results;
}

/**
 * Send a direct message to a user
 */
async function sendDirectMessage(recipientId, message) {
  try {
    const resp = await fetch(`${HEARTBEAT_BASE}/directMessages`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        to: recipientId,
        text: message
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${err}`);
    }

    return await resp.json();
  } catch (err) {
    console.error('[Heartbeat] Send DM failed:', err.message);
    throw err;
  }
}

/**
 * Create a webhook
 */
async function createWebhook(webhookName, url, filter = null) {
  try {
    const body = {
      action: {
        name: webhookName
      },
      url
    };

    // Add filter if provided
    if (filter) {
      body.action.filter = filter;
    }

    const resp = await fetch(`${HEARTBEAT_BASE}/webhooks`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${err}`);
    }

    return await resp.json();
  } catch (err) {
    console.error(`[Heartbeat] Create webhook ${webhookName} failed:`, err.message);
    throw err;
  }
}

/**
 * List all webhooks
 */
async function listWebhooks() {
  try {
    const resp = await fetch(`${HEARTBEAT_BASE}/webhooks`, {
      headers: headers()
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${err}`);
    }

    return await resp.json();
  } catch (err) {
    console.error('[Heartbeat] List webhooks failed:', err.message);
    throw err;
  }
}

/**
 * Delete a webhook
 */
async function deleteWebhook(webhookId) {
  try {
    const resp = await fetch(`${HEARTBEAT_BASE}/webhooks/${webhookId}`, {
      method: 'DELETE',
      headers: headers()
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${err}`);
    }

    return true;
  } catch (err) {
    console.error('[Heartbeat] Delete webhook failed:', err.message);
    throw err;
  }
}

module.exports = { findUser, syncAll, sendDirectMessage, createWebhook, listWebhooks, deleteWebhook };
