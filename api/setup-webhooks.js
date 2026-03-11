const { createWebhook, listWebhooks, deleteWebhook } = require('./_lib/heartbeat');

/**
 * POST: Set up webhooks
 * GET: List current webhooks
 * DELETE: Remove all webhooks (for cleanup)
 */
module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      return await setupWebhooks(req, res);
    } else if (req.method === 'GET') {
      return await listCurrentWebhooks(req, res);
    } else if (req.method === 'DELETE') {
      return await cleanupWebhooks(req, res);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[Setup-Webhooks] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Create all 3 webhooks
 */
async function setupWebhooks(req, res) {
  const vercelUrl = process.env.VERCEL_URL 
    ? `https://${process.env.VERCEL_URL}`
    : 'https://charlie-mentor.vercel.app';
  const webhookUrl = `${vercelUrl}/api/webhook`;
  const CHARLIE_USER_ID = '4123ccdd-a337-4438-b5ff-fcaad1464102';

  console.log('[Setup] Creating webhooks pointing to:', webhookUrl);

  const webhooks = [
    {
      name: 'DIRECT_MESSAGE',
      filter: { userID: CHARLIE_USER_ID }
    },
    {
      name: 'USER_JOIN',
      filter: null
    },
    {
      name: 'GROUP_JOIN',
      filter: null
    }
  ];

  const results = {
    created: [],
    failed: []
  };

  for (const webhook of webhooks) {
    try {
      const result = await createWebhook(webhook.name, webhookUrl, webhook.filter);
      results.created.push({ name: webhook.name, ...result });
      console.log(`[Setup] ✓ Created ${webhook.name} webhook`);
    } catch (err) {
      results.failed.push({ name: webhook.name, error: err.message });
      console.error(`[Setup] ✗ Failed to create ${webhook.name}:`, err.message);
    }
  }

  return res.status(200).json({
    message: 'Webhook setup complete',
    webhookUrl,
    ...results
  });
}

/**
 * List current webhooks
 */
async function listCurrentWebhooks(req, res) {
  console.log('[Setup] Listing webhooks...');
  
  const webhooks = await listWebhooks();

  return res.status(200).json({
    count: webhooks.length || 0,
    webhooks: webhooks
  });
}

/**
 * Delete all webhooks (for cleanup/testing)
 */
async function cleanupWebhooks(req, res) {
  console.log('[Setup] Cleaning up webhooks...');

  const webhooks = await listWebhooks();
  const results = {
    deleted: [],
    failed: []
  };

  for (const webhook of webhooks) {
    try {
      await deleteWebhook(webhook.id);
      results.deleted.push(webhook.id);
      console.log(`[Setup] ✓ Deleted webhook ${webhook.id}`);
    } catch (err) {
      results.failed.push({ id: webhook.id, error: err.message });
      console.error(`[Setup] ✗ Failed to delete ${webhook.id}:`, err.message);
    }
  }

  return res.status(200).json({
    message: 'Webhook cleanup complete',
    ...results
  });
}
