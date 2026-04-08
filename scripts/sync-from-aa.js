#!/usr/bin/env node
/**
 * sync-from-aa.js
 * Syncs model data from Artificial Analysis API into our models.json
 *
 * SETUP:
 * 1. Get a free API key at https://artificialanalysis.ai/login
 * 2. Store it in ~/.config/llm-value-comparison/aa_api_key
 *    (one line, just the key, no quotes)
 * 3. Run: node scripts/sync-from-aa.js
 *
 * WHAT IT DOES:
 * - Fetches all models from Artificial Analysis API
 * - For each model in our models.json, updates:
 *   - API pricing (input/output per 1M tokens)
 *   - AA Intelligence Index score
 *   - Output tokens/sec (API speed)
 * - Adds new models it finds that match our priority list
 * - Never removes existing models
 * - Preserves local inference data and subscription data (AA doesn't have these)
 *
 * DATA ATTRIBUTION:
 * Benchmark and pricing data from https://artificialanalysis.ai/
 * Required by their free API terms.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const MODELS_FILE = path.join(DATA_DIR, 'models.json');
const AA_API = 'https://artificialanalysis.ai/api/v2/data/llms/models';
const ARENA_TEXT_API = 'https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=text';
const ARENA_CODE_API = 'https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=code';
const OPENROUTER_API = 'https://openrouter.ai/api/v1/models';

// --- Load API key ---
function loadApiKey() {
  const keyFile = path.join(os.homedir(), '.config', 'llm-value-comparison', 'aa_api_key');
  if (!fs.existsSync(keyFile)) {
    console.error(`
ERROR: API key not found at ${keyFile}

To fix:
  1. Get a free API key at https://artificialanalysis.ai/login
  2. mkdir -p ~/.config/llm-value-comparison
  3. echo "your_key_here" > ~/.config/llm-value-comparison/aa_api_key
  4. chmod 600 ~/.config/llm-value-comparison/aa_api_key
`);
    process.exit(1);
  }
  return fs.readFileSync(keyFile, 'utf8').trim();
}

// --- Models we want to track (slug patterns from AA) ---
// Add slugs here to pull new models automatically
const PRIORITY_SLUGS = [
  // Anthropic
  'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-4-5-haiku',
  'claude-opus-4-5', 'claude-4-5-sonnet',
  // OpenAI
  'gpt-5-4', 'gpt-5-3-codex', 'gpt-5-2', 'gpt-5-2-codex',
  'gpt-4o', 'o3',
  // Google
  'gemini-3-1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2-5-pro',
  // Chinese frontier
  'glm-5', 'glm-4-7', 'glm-4-7-flash',
  'minimax-m2-5', 'minimax-m2-7',
  'kimi-k2-5',
  'deepseek-v3-2',
  'qwen3-5-35b-a3b', 'qwen3-5-27b', 'qwen3-5-122b-a10b',
  // Google open weights
  'gemma-4-31b', 'gemma-4-26b-a4b-it',
];

// Mapping: AA slug → our model ID in models.json
// If AA slug matches but our ID is different, map it here
const SLUG_TO_OUR_ID = {
  'claude-opus-4-6':          'claude-opus-4-6',
  'claude-sonnet-4-6':        'claude-sonnet-4-6',
  'claude-opus-4-5':          'claude-opus-4-5',
  'claude-opus-4-5':          'claude-opus-4-5',
  'gemini-3-1-pro-preview':   'gemini-3-1-pro',
  'gemini-3-pro-preview':     'gemini-3-pro',
  'gemini-3-flash-preview':   'gemini-3-flash',
  'gemini-2-5-pro':           'gemini-2.5-pro',
  'gpt-5-4':                  'gpt-5-4',
  'gpt-5-2':                  'gpt-5-2',
  'gpt-5-3-codex':            'gpt-5-3-codex',
  'glm-5':                    'glm-5',
  'glm-4-7':                  'glm-4.7',
  'glm-4-7-flash':            'glm-4.7-flash',
  'minimax-m2-5':             'minimax-m2.5',
  'minimax-m2-7':             'minimax-m2.7',
  'kimi-k2-5':                'kimi-k2.5',
  'deepseek-v3-2':            'deepseek-v3.2',
  'qwen3-5-35b-a3b':          'qwen3.5-35b-a3b',
  'qwen3-5-27b':              'qwen3.5-27b',
  'qwen3-5-122b-a10b':        'qwen3.5-122b-a10b',
  'gemma-4-31b':              'gemma-4-31b',
  'gemma-4-26b-a4b-it':       'gemma-4-26b-a4b',
};

// --- Convert AA model to our format ---
function aaToOurFormat(aa) {
  const slug = aa.slug;
  const ourId = SLUG_TO_OUR_ID[slug] || slug;
  const p = aa.pricing || {};
  const ev = aa.evaluations || {};

  return {
    id: ourId,
    name: aa.name,
    provider: aa.model_creator?.name || 'Unknown',
    releaseDate: aa.release_date || 'unknown',
    modelCard: `https://artificialanalysis.ai/models/${slug}`,
    benchmarks: {
      ...(ev.artificial_analysis_intelligence_index != null && {
        aa_intelligence: {
          score: parseFloat(ev.artificial_analysis_intelligence_index.toFixed(1)),
          source: `https://artificialanalysis.ai/models/${slug}`
        }
      }),
      ...(ev.gpqa != null && {
        gpqa_diamond: {
          score: parseFloat((ev.gpqa * 100).toFixed(1)),
          source: `https://artificialanalysis.ai/models/${slug}`
        }
      }),
      // Note: arena_text and arena_code are added separately in the main loop
    // after fetching from the Arena leaderboard APIs
    },
    api: (p.price_1m_input_tokens != null && p.price_1m_input_tokens > 0) ? {
      inputPer1M: p.price_1m_input_tokens,
      outputPer1M: p.price_1m_output_tokens,
      tokensPerSecAPI: aa.median_output_tokens_per_second
        ? parseFloat(aa.median_output_tokens_per_second.toFixed(1))
        : null,
      source: `https://artificialanalysis.ai/models/${slug}`
    } : null,
    local: null,
    subscriptions: null,
    _aa_synced: new Date().toISOString().split('T')[0],
  };
}

// --- Main ---
async function main() {
  const apiKey = loadApiKey();

  // Fetch all three sources in parallel
  console.log('Fetching from all sources in parallel...');
  const [aaRes, arenaTextRes, arenaCodeRes, orRes] = await Promise.all([
    fetch(AA_API, { headers: { 'x-api-key': apiKey } }),
    fetch(ARENA_TEXT_API),
    fetch(ARENA_CODE_API),
    fetch(OPENROUTER_API),
  ]);

  const { data: aaModels } = await aaRes.json();
  const arenaTextData = await arenaTextRes.json();
  const arenaCodeData = await arenaCodeRes.json();
  const orData = await orRes.json();

  console.log(`AA: ${aaModels.length} models | Arena text: ${arenaTextData.models?.length} | Arena code: ${arenaCodeData.models?.length} | OpenRouter: ${orData.data?.length}`);

  // Index sources
  const aaBySlug = {};
  for (const m of aaModels) aaBySlug[m.slug] = m;

  // Arena ELO by model slug — separate text and code leaderboards
  const arenaTextBySlug = {};
  for (const m of (arenaTextData.models || [])) arenaTextBySlug[m.model] = m.score;

  const arenaCodeBySlug = {};
  for (const m of (arenaCodeData.models || [])) arenaCodeBySlug[m.model] = m.score;

  // OpenRouter pricing by model ID
  const orBySlug = {};
  for (const m of (orData.data || [])) {
    const p = m.pricing || {};
    if (p.prompt && parseFloat(p.prompt) > 0) {
      orBySlug[m.id] = {
        inputPer1M: parseFloat(p.prompt) * 1_000_000,
        outputPer1M: parseFloat(p.completion) * 1_000_000,
        source: `https://openrouter.ai/${m.id}`,
      };
    }
  }

  const existing = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
  let updated = 0, added = 0, skipped = 0;

  // Update existing models
  for (const [ourId, ourModel] of Object.entries(existing)) {
    // Find matching AA slug
    const aaSlug = Object.entries(SLUG_TO_OUR_ID).find(([,id]) => id === ourId)?.[0];
    const aa = aaSlug ? aaBySlug[aaSlug] : null;
    if (!aa) { skipped++; continue; }

    const p = aa.pricing || {};
    const ev = aa.evaluations || {};

    // Update API pricing
    if (p.price_1m_input_tokens != null && p.price_1m_input_tokens > 0) {
      existing[ourId].api = {
        ...existing[ourId].api,
        inputPer1M: p.price_1m_input_tokens,
        outputPer1M: p.price_1m_output_tokens,
        tokensPerSecAPI: aa.median_output_tokens_per_second
          ? parseFloat(aa.median_output_tokens_per_second.toFixed(1)) : null,
        source: `https://artificialanalysis.ai/models/${aaSlug}`,
      };
    }

    // Update AA benchmark score
    if (ev.artificial_analysis_intelligence_index != null) {
      existing[ourId].benchmarks = existing[ourId].benchmarks || {};
      existing[ourId].benchmarks.aa_intelligence = {
        score: parseFloat(ev.artificial_analysis_intelligence_index.toFixed(1)),
        source: `https://artificialanalysis.ai/models/${aaSlug}`
      };
    }

    // Update Arena ELO — write to arena_text and arena_code keys (stable benchmarks)
    // NOT to arena_elo (legacy key no longer used for scoring)
    const arenaSlugCandidates = [aaSlug, ourId, ourId.replace(/\./g, '-')];
    for (const slug of arenaSlugCandidates) {
      if (arenaTextBySlug[slug]) {
        existing[ourId].benchmarks = existing[ourId].benchmarks || {};
        existing[ourId].benchmarks.arena_text = {
          score: arenaTextBySlug[slug],
          source: 'https://lmarena.ai/leaderboard'
        };
        // Remove stale arena_elo key if present
        delete existing[ourId].benchmarks.arena_elo;
        break;
      }
    }
    for (const slug of arenaSlugCandidates) {
      if (arenaCodeBySlug[slug]) {
        existing[ourId].benchmarks = existing[ourId].benchmarks || {};
        existing[ourId].benchmarks.arena_code = {
          score: arenaCodeBySlug[slug],
          source: 'https://lmarena.ai/leaderboard/code'
        };
        break;
      }
    }

    // Update OpenRouter pricing if no first-party API pricing exists
    // (useful for open-weight models like Gemma 4)
    const orSlugCandidates = [`google/${ourId}-it`, `google/${ourId}`, ourId];
    for (const slug of orSlugCandidates) {
      if (orBySlug[slug] && !existing[ourId].api?.inputPer1M) {
        existing[ourId].api = { ...orBySlug[slug] };
        break;
      }
    }

    existing[ourId]._aa_synced = new Date().toISOString().split('T')[0];
    updated++;
  }

  // Add new priority models not yet in our data
  for (const slug of PRIORITY_SLUGS) {
    const aa = aaBySlug[slug];
    if (!aa) continue;
    const ourId = SLUG_TO_OUR_ID[slug] || slug;
    if (existing[ourId]) continue; // already have it

    console.log(`  + Adding new model: ${aa.name} (${ourId})`);
    existing[ourId] = aaToOurFormat(aa);
    added++;
  }

  // Write back
  fs.writeFileSync(MODELS_FILE, JSON.stringify(existing, null, 2));
  console.log(`\nDone. Updated: ${updated}, Added: ${added}, Skipped (no AA match): ${skipped}`);
  console.log(`\nNote: Local inference speeds and subscription data must be added manually.`);
  console.log(`Data attribution: https://artificialanalysis.ai/`);
}

main().catch(err => { console.error(err); process.exit(1); });
