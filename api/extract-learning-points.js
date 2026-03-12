import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || 'https://wmrlffmknipgbmzwfpsc.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

export default async function handler(req, res) {
  // CORS headers for async status checks
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (!supabaseKey || !openaiKey) {
    return res.status(500).json({ 
      error: 'Missing environment variables (SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY)' 
    });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Check if this is a status check
    if (req.query.status === 'true') {
      const { count } = await supabase
        .from('lesson_index')
        .select('id', { count: 'exact', head: true });
      
      return res.status(200).json({ 
        status: 'running',
        lessons_processed: count || 0 
      });
    }

    // Return 202 immediately - work happens asynchronously
    res.status(202).json({ 
      message: 'Extraction started in background',
      status_url: `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/extract-learning-points?status=true`
    });

    // Do the actual work AFTER responding
    setImmediate(async () => {
      try {
        console.log('[extract-learning-points] Starting extraction...');

        // Get all transcripts that don't have learning points extracted yet
        const { data: transcripts, error: fetchError } = await supabase
          .from('transcripts')
          .select('id, lesson_id, lesson_url, lesson_name, week, type, lesson_number, content')
          .is('id', null) // Get all - we'll check lesson_index separately
          .limit(250);

        if (fetchError) throw fetchError;

        if (!transcripts || transcripts.length === 0) {
          console.log('[extract-learning-points] No transcripts found');
          return;
        }

        console.log(`[extract-learning-points] Found ${transcripts.length} transcripts to process`);

        let processed = 0;
        let skipped = 0;

        for (const transcript of transcripts) {
          try {
            // Check if already extracted
            const { data: existing } = await supabase
              .from('lesson_index')
              .select('id')
              .eq('lesson_id', transcript.lesson_id)
              .single();

            if (existing) {
              skipped++;
              continue;
            }

            // Extract learning points using Claude
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openaiKey}`
              },
              body: JSON.stringify({
                model: 'gpt-4-turbo',
                temperature: 0.3,
                max_tokens: 500,
                messages: [
                  {
                    role: 'system',
                    content: `You are an expert English language instructor. Extract 4-8 specific, granular learning points from this lesson transcript. 
                    
Each point should be:
- A concrete concept or skill students will learn
- Specific enough to search by (not generic)
- In the format: "Topic: specific detail or rule"

Examples:
- "Contractions with TO BE: 's, 'm, 're forms and when contractions are forbidden (negative imperatives)"
- "Pronunciation: Word stress differences between noun (RECord) and verb (reCORD) forms"
- "Common mistakes: When to use 'much' vs 'many' with countable/uncountable nouns"

Return ONLY a JSON array of strings, no other text.`
                  },
                  {
                    role: 'user',
                    content: `Extract learning points from this lesson:\n\n${transcript.content.substring(0, 8000)}`
                  }
                ]
              })
            });

            if (!response.ok) {
              const error = await response.text();
              console.log(`[extract-learning-points] Claude API error for lesson ${transcript.lesson_id}: ${error}`);
              continue;
            }

            const data = await response.json();
            let learningPoints = [];

            try {
              const content = data.choices[0].message.content;
              learningPoints = JSON.parse(content);
              
              if (!Array.isArray(learningPoints)) {
                learningPoints = [content];
              }
            } catch (e) {
              console.log(`[extract-learning-points] Could not parse Claude response for ${transcript.lesson_id}`);
              continue;
            }

            // Store in lesson_index
            const { error: insertError } = await supabase
              .from('lesson_index')
              .upsert({
                lesson_id: transcript.lesson_id,
                lesson_url: transcript.lesson_url,
                lesson_name: transcript.lesson_name,
                week: transcript.week,
                type: transcript.type,
                lesson_number: transcript.lesson_number,
                learning_points: learningPoints,
                transcript_summary: transcript.content.substring(0, 500),
                created_at: new Date().toISOString()
              }, { onConflict: 'lesson_id' });

            if (insertError) {
              console.log(`[extract-learning-points] Insert error for ${transcript.lesson_id}: ${insertError.message}`);
              continue;
            }

            processed++;
            if (processed % 10 === 0) {
              console.log(`[extract-learning-points] Progress: ${processed} processed, ${skipped} skipped`);
            }

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));

          } catch (error) {
            console.log(`[extract-learning-points] Error processing lesson ${transcript.lesson_id}: ${error.message}`);
          }
        }

        console.log(`[extract-learning-points] Complete: ${processed} extracted, ${skipped} skipped`);

      } catch (error) {
        console.error('[extract-learning-points] Background error:', error.message);
      }
    });

  } catch (error) {
    console.error('[extract-learning-points] Handler error:', error);
    return res.status(500).json({ 
      error: error.message 
    });
  }
}
