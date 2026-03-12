/**
 * Async endpoint to extract learning points from all transcripts
 * Kicks off background extraction that populates lesson_index table
 * 
 * Usage: GET /api/extract-learning-points?start=0&batch_size=50
 * Returns: 202 Accepted immediately, extraction runs async in background
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_PROJECT_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper to call OpenAI API for learning point extraction
async function extractLearningPoints(transcript, lessonName) {
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
          content: `You are an expert language learning instructor. Analyze lesson transcripts and extract the KEY LEARNING POINTS - the specific concepts, grammar rules, pronunciation tips, and vocabulary patterns students will learn.

Output ONLY a JSON array with 4-8 learning points. Each point should be:
- Specific and actionable (not generic)
- Distinct from other lessons (even similar ones)
- Include concrete examples or distinctions
- 1-2 sentences max per point

Example format:
["Contractions with TO BE: 's, 'm, 're, 'd, 've, 'll forms and common spelling mistakes", "When contractions are forbidden or change meaning: negative imperatives, emphatic statements", "Pronunciation in connected speech: stressed vs. reduced forms"]

Return ONLY valid JSON array, no markdown, no explanation.`
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
    console.error(`OpenAI error for ${lessonName}:`, error);
    return [];
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();
  
  try {
    // Parse JSON response
    const points = JSON.parse(content);
    return Array.isArray(points) ? points : [];
  } catch (e) {
    console.error(`JSON parse error for ${lessonName}:`, e.message);
    return [];
  }
}

// Main extraction function (runs async, doesn't block response)
async function runExtraction(startIndex = 0, batchSize = 50) {
  console.log(`[extract-learning-points] Starting extraction from index ${startIndex}, batch size ${batchSize}`);

  try {
    // Load transcript mappings (try multiple locations for deployment flexibility)
    let transcriptsPath = path.join(__dirname, '../data/transcripts_extracted.json');
    if (!fs.existsSync(transcriptsPath)) {
      transcriptsPath = '/tmp/transcripts_extracted.json';
    }
    if (!fs.existsSync(transcriptsPath)) {
      console.error('[extract-learning-points] transcripts_extracted.json not found');
      throw new Error('Transcript data not found in deployment');
    }

    const transcriptsData = JSON.parse(fs.readFileSync(transcriptsPath, 'utf8'));
    const lessons = transcriptsData.lessons || [];

    if (lessons.length === 0) {
      console.error('[extract-learning-points] No lessons found in transcripts data');
      return;
    }

    console.log(`[extract-learning-points] Found ${lessons.length} lessons, processing from index ${startIndex}`);

    // Build URL map from lesson metadata
    // Format: /courses/l/{lessonId} for individual lessons
    // Note: Exact URLs may differ; this provides fallback structure
    let urlMap = {};
    lessons.forEach(lesson => {
      if (lesson.lesson_id) {
        // Try to build a reasonable URL from metadata
        // Actual lesson URLs should come from the lesson_id directly
        urlMap[lesson.lesson_id] = `/courses/l/${lesson.lesson_id}`;
      }
    });

    let processedCount = 0;
    let successCount = 0;
    let endIndex = Math.min(startIndex + batchSize, lessons.length);

    for (let i = startIndex; i < endIndex; i++) {
      const lesson = lessons[i];
      if (!lesson.text || !lesson.lesson_id) {
        console.log(`[extract-learning-points] Skipping lesson ${i} - missing data`);
        continue;
      }

      try {
        console.log(`[extract-learning-points] Processing [${i + 1}/${lessons.length}] ${lesson.lesson_name}`);

        // Extract learning points via OpenAI
        const learningPoints = await extractLearningPoints(lesson.text, lesson.lesson_name);

        if (learningPoints.length === 0) {
          console.log(`[extract-learning-points] No learning points extracted for ${lesson.lesson_name}`);
          processedCount++;
          continue;
        }

        // Upsert into lesson_index table
        const lessonUrl = urlMap[lesson.lesson_id] || '';
        
        const { data, error } = await supabase
          .from('lesson_index')
          .upsert({
            lesson_id: lesson.lesson_id,
            lesson_url: lessonUrl,
            lesson_name: lesson.lesson_name,
            week: lesson.week || null,
            type: lesson.type || null,
            lesson_number: lesson.lesson_number || null,
            learning_points: learningPoints,
            transcript_summary: lesson.text.substring(0, 500)
          }, { onConflict: 'lesson_id' });

        if (error) {
          console.error(`[extract-learning-points] Upsert error for ${lesson.lesson_name}:`, error);
        } else {
          successCount++;
          console.log(`[extract-learning-points] ✓ Stored ${learningPoints.length} points for ${lesson.lesson_name}`);
        }

        processedCount++;

        // Rate limiting: OpenAI free tier is cautious, add small delay
        if (processedCount % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

      } catch (lessonError) {
        console.error(`[extract-learning-points] Error processing lesson ${lesson.lesson_id}:`, lessonError.message);
        processedCount++;
      }
    }

    console.log(`[extract-learning-points] Batch complete: ${successCount}/${processedCount} lessons processed`);
    console.log(`[extract-learning-points] Total progress: ${endIndex}/${lessons.length}`);

    // If more lessons remain, schedule next batch
    if (endIndex < lessons.length) {
      console.log(`[extract-learning-points] Scheduling next batch starting at index ${endIndex}`);
      // Note: Vercel functions can't schedule directly, but logs show progress
      // User can manually restart with ?start=${endIndex} or set up a cron trigger
    }

  } catch (error) {
    console.error('[extract-learning-points] Fatal error:', error);
  }
}

// Main handler
module.exports = async (req, res) => {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse query params
  const startIndex = parseInt(req.query.start || '0');
  const batchSize = parseInt(req.query.batch_size || '50');

  console.log(`[extract-learning-points] Triggered with start=${startIndex}, batch_size=${batchSize}`);

  // Return 202 Accepted immediately
  res.status(202).json({
    status: 'extraction_started',
    message: `Processing ${batchSize} lessons starting from index ${startIndex}. Check Vercel logs for progress.`,
    start_index: startIndex,
    batch_size: batchSize,
    note: 'This endpoint runs asynchronously. Monitor progress in Vercel function logs.',
    next_request: `Visit /api/extract-learning-points?start=${startIndex + batchSize}&batch_size=${batchSize} to process next batch once this completes.`
  });

  // Run extraction in background (non-blocking)
  runExtraction(startIndex, batchSize).catch(err => {
    console.error('[extract-learning-points] Background error:', err);
  });
};
