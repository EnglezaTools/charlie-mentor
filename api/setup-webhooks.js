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
  const webhookUrl = `${process.env.VERCEL_URL || 'https://charlie-mentor.vercel.app'}/api/webhook`;

  console.log('[Setup] Creating webhooks pointing to:', webhookUrl);

  const events = [
    'DIRECT_MESSAGE',
    'USER_JOIN',
    'GROUP_JOIN'
  ];

  const results = {
    created: [],
    failed: []
  };

  for (const event of events) {
    try {
      const result = await createWebhook(event, webhookUrl);
      results.created.push({ event, ...result });
      console.log(`[Setup] ✓ Created ${event} webhook`);
    } catch (err) {
      results.failed.push({ event, error: err.message });
      console.error(`[Setup] ✗ Failed to create ${event}:`, err.message);
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
