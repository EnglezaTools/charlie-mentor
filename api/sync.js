const { syncAll } = require('./_lib/heartbeat');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).set(CORS_HEADERS).end();
  }

  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'GET') {
    return res.status(405).json({ detail: 'Method not allowed' });
  }

  try {
    const secret = req.query.secret;

    if (!secret || secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ detail: 'Invalid secret.' });
    }

    const results = await syncAll();

    return res.status(200).json({
      status: 'ok',
      synced: {
        channels: results.channels,
        courses: results.courses,
        members: results.members
      },
      errors: results.errors.length > 0 ? results.errors : undefined,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('[Sync] Error:', err);
    return res.status(500).json({ detail: 'Sync failed: ' + err.message });
  }
};
