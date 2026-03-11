const { supabase } = require('./_lib/supabase');

/**
 * Search transcripts for relevant lessons
 * GET /api/search-transcripts?q=<query>&type=<type>&week=<week>&limit=<limit>
 */
module.exports = async (req, res) => {
  try {
    const { q, type, week, limit = 5 } = req.query;

    if (!q && !type && !week) {
      return res.status(400).json({ error: 'Provide at least q, type, or week parameter' });
    }

    let query = supabase.from('transcripts').select('id, week, type, lesson_number, part, title, content');

    // Text search
    if (q) {
      query = query.or(`content.ilike.%${q}%,title.ilike.%${q}%`);
    }

    // Filter by type
    if (type) {
      query = query.eq('type', type);
    }

    // Filter by week
    if (week) {
      query = query.eq('week', parseInt(week));
    }

    const { data, error } = await query.limit(parseInt(limit));

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: 'Database error' });
    }

    // Return truncated content (first 1000 chars) to save bandwidth
    const results = (data || []).map(t => ({
      id: t.id,
      title: t.title,
      week: t.week,
      type: t.type,
      lesson_number: t.lesson_number,
      part: t.part,
      content_preview: t.content ? t.content.substring(0, 1000) : '',
      content_length: t.content ? t.content.length : 0
    }));

    res.status(200).json({
      count: results.length,
      results
    });

  } catch (err) {
    console.error('Error searching transcripts:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
