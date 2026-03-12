/**
 * Async endpoint to extract learning points from all transcripts
 * Loads transcripts from JSON file in deployment
 */

const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_PROJECT_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Load transcripts data
let transcriptData = null;
function getTranscripts() {
  if (!transcriptData) {
    try {
      transcriptData = require('../data/transcripts_extracted.json');
    } catch (e) {
      console.error('[extract-learning-points] Failed to load transcripts:', e.message);
      return null;
    }
  }
  return transcriptData;
}

// Helper to call OpenAI API for learning point extraction
async function extractLearningPoints(transcript, lessonName) {
  if (!process.env.OPENAI_API_KEY) {
    console.error('[extract-learning-points] OPENAI_API_KEY not set');
    return [];
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an expert language learning instructor. Analyze lesson transcripts and extract 4-8 KEY LEARNING POINTS - specific concepts, grammar rules, pronunciation tips, or vocabulary patterns students will learn.

Each point should be:
- Specific and actionable (not generic)
- Distinct from other lessons (avoid generic topics like "verb to be")
- Include concrete examples or distinctions
- 1-2 sentences max

Example format for different lessons on similar topics:
Lesson A: "Contractions with TO BE: 's, 'm, 're, 'd, 've, 'll forms and common spelling mistakes"
Lesson B: "When contractions change meaning or are forbidden: negative imperatives, emphatic statements, tag questions"

Return ONLY a valid JSON array, no markdown, no explanation.`
        },
        {
          role: 'user',
          content: `Extract learning points from this lesson transcript:\n\n${transcript.substring(0, 3000)}`
        }
      ],
      temperature: 0.7,
      max_tokens: 500
    })
  });

  if (!response.ok) {
    const error = await response.json();
    console.error(`[extract-learning-points] OpenAI error for ${lessonName}:`, error.error?.message || error);
    return [];
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content?.trim();
  
  if (!content) {
    console.error(`[extract-learning-points] Empty response from OpenAI for ${lessonName}`);
    return [];
  }

  try {
    const points = JSON.parse(content);
    return Array.isArray(points) ? points : [];
  } catch (e) {
    console.error(`[extract-learning-points] JSON parse error for ${lessonName}:`, e.message, 'Content:', content.substring(0, 100));
    return [];
  }
}

// Main extraction function
async function runExtraction(startIndex = 0, batchSize = 50) {
  console.log(`[extract-learning-points] Starting extraction from index ${startIndex}, batch size ${batchSize}`);

  try {
    // Load transcript data from JSON
    const data = getTranscripts();
    if (!data || !data.lessons) {
      console.error('[extract-learning-points] Failed to load transcript data');
      return;
    }

    const lessons = data.lessons;
    const endIndex = Math.min(startIndex + batchSize, lessons.length);

    console.log(`[extract-learning-points] Loaded ${lessons.length} total lessons, processing ${startIndex}-${endIndex}`);

    let successCount = 0;
    let skippedCount = 0;

    for (let i = startIndex; i < endIndex; i++) {
      const lesson = lessons[i];
      
      if (!lesson.lesson_id || !lesson.text) {
        console.log(`[extract-learning-points] Skipping lesson ${i}: missing data`);
        skippedCount++;
        continue;
      }

      try {
        console.log(`[extract-learning-points] [${i + 1}/${lessons.length}] Extracting: ${lesson.lesson_name}`);

        // Extract learning points
        const learningPoints = await extractLearningPoints(lesson.text, lesson.lesson_name);

        if (learningPoints.length === 0) {
          console.log(`[extract-learning-points]   → No points extracted (may be exercise/short content)`);
          continue;
        }

        // Upsert into lesson_index
        const { error: upsertError } = await supabase
          .from('lesson_index')
          .upsert({
            lesson_id: lesson.lesson_id,
            lesson_url: `/courses/l/${lesson.lesson_id}`,
            lesson_name: lesson.lesson_name,
            week: lesson.week || null,
            type: lesson.type || null,
            lesson_number: lesson.lesson_number || null,
            learning_points: learningPoints,
            transcript_summary: lesson.text.substring(0, 500)
          }, { onConflict: 'lesson_id' });

        if (upsertError) {
          console.error(`[extract-learning-points]   ✗ Upsert failed:`, upsertError.message);
        } else {
          successCount++;
          console.log(`[extract-learning-points]   ✓ Stored ${learningPoints.length} points`);
        }

        // Rate limiting to respect OpenAI API
        if ((i - startIndex + 1) % 10 === 0) {
          console.log(`[extract-learning-points] Processed ${i - startIndex + 1} in this batch, pausing...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

      } catch (lessonError) {
        console.error(`[extract-learning-points] Error processing lesson ${lesson.lesson_id}:`, lessonError.message);
      }
    }

    const nextStart = endIndex < lessons.length ? endIndex : null;
    console.log(`[extract-learning-points] ✓ Batch complete: ${successCount} successful, ${skippedCount} skipped`);
    if (nextStart) {
      console.log(`[extract-learning-points] → Next batch: /api/extract-learning-points?start=${nextStart}`);
    } else {
      console.log(`[extract-learning-points] ✓ EXTRACTION COMPLETE! All ${lessons.length} lessons processed.`);
    }

  } catch (error) {
    console.error('[extract-learning-points] Fatal error:', error.message);
    console.error(error.stack);
  }
}

// Main handler
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startIndex = parseInt(req.query.start || '0');
  const batchSize = parseInt(req.query.batch_size || '50');

  console.log(`[extract-learning-points] Endpoint triggered: start=${startIndex}, batch=${batchSize}`);

  // Return 202 immediately
  res.status(202).json({
    status: 'extraction_started',
    message: `Processing batch starting at lesson ${startIndex}. Watch Vercel logs for progress.`,
    start_index: startIndex,
    batch_size: batchSize,
    estimated_duration: `${Math.ceil((batchSize / 60) * 5)} minutes`,
    next_batch_url: `Visit /api/extract-learning-points?start=${startIndex + batchSize} after this batch completes (if needed)`
  });

  // Run extraction asynchronously (non-blocking)
  runExtraction(startIndex, batchSize).catch(err => {
    console.error('[extract-learning-points] Background error:', err.message);
  });
};
