#!/usr/bin/env node
/**
 * Update models.json subscription tokensPerWeek from measurement files.
 *
 * Reads measurements/*.json, picks the BEST measurement per (plan, model)
 * pair based on flip-delta quality, and updates only the matching model
 * rows in data/models.json.
 *
 * Three structural fixes vs the old script:
 *
 * 1. PICKER QUALITY (not just consumed-percent). A 200-run measurement that
 *    captures 2 clean flip-deltas with tight spread beats a 30-run one that
 *    crossed 5h-percent in a single noisy step. Quality tiers:
 *      multi-flip   — flip_count >= 2 AND tight delta spread
 *      single-flip  — flip_count == 1
 *      legacy-pct   — old runs without flip metadata, fall back to %-consumed
 *
 * 2. (PLAN, MODEL) MATCHING. The old script grouped by plan only and applied
 *    one measurement to every model_id sharing that subscription. So a
 *    Sonnet-4.6 measurement would update Opus-4.7 rows and vice versa.
 *    Now: a measurement with model="Sonnet 4.6" only updates models.json
 *    rows whose `name` starts with "Claude Sonnet 4.6". Same for Opus 4.7,
 *    GPT-5.5, etc.
 *
 * 3. CURATED-NOTE PRESERVATION. A `notes` field is only auto-overwritten
 *    when it looks like a previous auto-generated string (matches the
 *    autogen template AND is short). Hand-curated notes are detected by
 *    length + content and left intact — only tokensPerWeek/confidence/
 *    source get updated, plus a "[auto-update YYYY-MM-DD: …]" trailer is
 *    appended for audit trail. Use --force to override.
 *
 * Source URL is read from package.json's repository field (works for
 * forks and renames).
 *
 * Usage:
 *   node scripts/update-sub-from-measurements.js              # apply
 *   node scripts/update-sub-from-measurements.js --dry-run    # preview
 *   node scripts/update-sub-from-measurements.js --force      # override
 *                                                             # curated-note
 *                                                             # protection
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const MEAS_DIR = path.join(REPO, 'measurements');
const MODELS_FILE = path.join(REPO, 'data', 'models.json');
const PKG_FILE = path.join(REPO, 'package.json');
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// ---- Repository URL: read from package.json so forks / renames work ----
function getRepoBlobBase() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf-8'));
    let url = pkg?.repository?.url || pkg?.repository || '';
    if (typeof url !== 'string') return null;
    url = url.replace(/^git\+/, '').replace(/\.git$/, '');
    if (!/^https?:/.test(url)) return null;
    return `${url}/blob/master`;
  } catch {
    return null;
  }
}
const REPO_BLOB_BASE = getRepoBlobBase()
  || 'https://github.com/wonderwhy-er/best-value-ai/blob/master';

// ---- Plan mapping: measurement.plan → subscription_id in models.json ----
const PLAN_MAP = {
  'Plus':            'chatgpt_plus',
  'Business':        'chatgpt_business',
  'Pro 100':         'chatgpt_pro_100',
  'Pro 200':         'chatgpt_pro_200',
  'Pro':             'chatgpt_pro_200',         // bare Pro → assume 200
  'Claude Pro':      'claude_pro',
  'Claude Max 5x':   'claude_max_5x',
  'Claude Max 20x':  'claude_max_20x',
  'Claude Max':      'claude_max_20x',          // bare Max → assume 20x
};

function normalizePlan(raw) {
  if (!raw) return 'unknown';
  let p = String(raw).trim();
  // "user@... (Plus)" → "Plus"  ;  "Plus ($20/mo)" → strip annotation
  const parenMatch = p.match(/\(([^)]+)\)/);
  if (parenMatch) {
    const inside = parenMatch[1].trim();
    if (/^(Plus|Business|Pro|Pro\s*\d+|Max(\s*\d+x)?|Claude\s+(Pro|Max(\s*\d+x)?))$/i.test(inside)) {
      p = inside;
    } else {
      p = p.replace(/\s*\([^)]*\)\s*/g, '').trim();
    }
  }
  // Capitalize canonical short forms
  const lower = p.toLowerCase();
  if (lower === 'plus') return 'Plus';
  if (lower === 'business') return 'Business';
  if (lower === 'pro') return 'Pro';
  return p;
}

// ---- Measurement.model → list of model_ids in models.json that should update ----
// A measurement updates a model row only if the row's `name` starts with the
// measured model name. So "Opus 4.7" updates rows named "Claude Opus 4.7 ...",
// "gpt-5.5" updates "GPT-5.5 ...", etc. Older model_ids (Opus 4.5, GPT-5.4)
// don't get touched by a 4.7 / 5.5 measurement — they keep their own data.
function findMatchingModelIds(measuredModel, models) {
  if (!measuredModel) return [];
  const m = String(measuredModel).trim();
  // Strip codex annotations: "gpt-5.5 (reasoning xhigh, summaries auto)" → "gpt-5.5"
  const measured = m.replace(/\s*\(.*\)\s*$/, '').trim();
  // Build the prefix this measurement implies in the models.json `name` field
  let namePrefix;
  if (/^Sonnet /i.test(measured)) namePrefix = `Claude ${measured}`;
  else if (/^Opus /i.test(measured)) namePrefix = `Claude ${measured}`;
  else if (/^Haiku /i.test(measured)) namePrefix = `Claude ${measured}`;
  else if (/^gpt-/i.test(measured)) namePrefix = measured.toUpperCase().replace('GPT-', 'GPT-');
  else namePrefix = measured;

  const matches = [];
  for (const [modelId, mv] of Object.entries(models)) {
    const name = mv.name || '';
    if (name.toLowerCase().startsWith(namePrefix.toLowerCase())) {
      matches.push(modelId);
    }
  }
  return matches;
}

// ---- Measurement quality scoring ----
function scoreMeasurement(d) {
  const e = d.estimates || {};
  const flipCount = e.target_meter_flip_count;
  const deltas = e.target_meter_flip_deltas || [];
  const allDeltas = e.target_meter_all_flip_deltas || [];

  // Tier 1: 2+ clean deltas captured. Score by tightness of spread.
  if (typeof flipCount === 'number' && flipCount >= 2 && deltas.length >= 2) {
    const mean = deltas.reduce((s, x) => s + x, 0) / deltas.length;
    const spread = mean > 0 ? (Math.max(...deltas) - Math.min(...deltas)) / mean : 1;
    return { tier: 'multi-flip', score: 1000 - Math.min(900, Math.round(spread * 1000)), flipCount, deltas, spread };
  }

  // Tier 2: 1 clean delta + at least one raw delta seen.
  if (typeof flipCount === 'number' && flipCount >= 1 && allDeltas.length >= 1) {
    return { tier: 'single-flip', score: 50, flipCount, deltas, spread: null };
  }

  // Tier 3: legacy run, fall back to consumed-percent.
  const consumed5h = d.quota_consumed?.['5h_pct'] || 0;
  const consumedWeekly = d.quota_consumed?.weekly_pct || d.quota_consumed?.weekly_all_pct || 0;
  const maxDelta = Math.max(consumed5h, consumedWeekly);
  return { tier: 'legacy-pct', score: Math.min(49, maxDelta), flipCount: 0, deltas: [], spread: null, maxDelta };
}

// ---- Curated-note detection ----
// Returns true if the note appears to be hand-written (rationale beyond the
// autogen template). The autogen template is exactly:
//   "Measured YYYY-MM-DD via TOOL. N runs, M tokens, X% 5h / Y% weekly consumed."
// Anything else, or anything longer than ~200 chars even matching the template,
// is treated as curated.
function isCuratedNote(notes) {
  if (!notes || typeof notes !== 'string') return false;
  const n = notes.trim();
  // Strip any auto-update trailer before testing the body, so notes that have
  // been updated once still get correctly classified as curated for re-update.
  const trailerStripped = n.replace(/\s*\[auto-update \d{4}-\d{2}-\d{2}: tokensPerWeek=[^\]]+\]\s*$/, '').trim();
  const autogenRe = /^Measured \d{4}-\d{2}-\d{2} via [\w-]+\. .+ runs, .+ tokens, \d+% 5h \/ \d+% weekly consumed\.\s*$/;
  if (autogenRe.test(trailerStripped) && trailerStripped.length < 200) return false;
  return true;
}

// ---- Read all measurements ----
const files = fs.readdirSync(MEAS_DIR).filter(f => f.endsWith('.json'));
const measurements = [];
let skippedFiles = 0;

for (const f of files) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(MEAS_DIR, f)));
    const est = d.estimates || {};
    const consumed5h = d.quota_consumed?.['5h_pct'] || 0;
    const consumedWeekly = d.quota_consumed?.weekly_pct || d.quota_consumed?.weekly_all_pct || 0;
    const quality = scoreMeasurement(d);

    // Compute weekly from per_1pct × 100 if available (cleaner extrapolation).
    const per1pct = est.target_meter_mean_tokens_per_1pct || est.target_meter_median_tokens_per_1pct || null;
    let estWeekly = null;
    let weeklyMethod = null;
    if (per1pct && typeof per1pct === 'number' && per1pct > 0) {
      estWeekly = Math.round(per1pct * 100);
      weeklyMethod = 'per_1pct_x_100';
    } else if (est.weekly_tokens) {
      estWeekly = est.weekly_tokens;
      weeklyMethod = 'estimates_weekly_tokens';
    }

    // Confidence label
    let confidence = 'low';
    if (quality.tier === 'multi-flip') confidence = quality.score >= 700 ? 'high' : 'medium';
    else if (quality.tier === 'legacy-pct' && quality.maxDelta >= 20) confidence = 'medium';

    measurements.push({
      file: f,
      tool: d.tool,
      plan: normalizePlan(d.plan),
      planRaw: d.plan,
      model: (d.model || '').replace(/\s*\(.*\)\s*$/, '').trim(),
      modelRaw: d.model,
      timestamp: d.timestamp,
      numRuns: d.num_runs,
      cacheBust: d.cache_bust,
      totalTokens: d.tokens?.total,
      consumed5h,
      consumedWeekly,
      estWeekly,
      weeklyMethod,
      quality,
      confidence,
      source: `measurements/${f}`,
    });
  } catch (e) {
    console.error(`  Skip ${f}: ${e.message}`);
    skippedFiles++;
  }
}
if (skippedFiles) console.log(`(${skippedFiles} files unreadable, skipped)\n`);

// ---- Group by (plan, model) ----
const byPair = {};
for (const m of measurements) {
  if (!m.plan || m.plan === 'unknown') continue;
  if (!m.model) continue;
  const key = `${m.plan}|${m.model}`;
  (byPair[key] = byPair[key] || []).push(m);
}

console.log('=== Best measurement per (plan, model) ===\n');
const bestPerPair = {};

for (const [key, ms] of Object.entries(byPair)) {
  ms.sort((a, b) => {
    if (b.quality.score !== a.quality.score) return b.quality.score - a.quality.score;
    return (b.timestamp || '').localeCompare(a.timestamp || '');
  });
  const best = ms.find(m => m.estWeekly) || null;
  if (best) bestPerPair[key] = best;

  const [plan, model] = key.split('|');
  console.log(`${plan} / ${model}  (${ms.length} runs)`);
  for (const m of ms.slice(0, 5)) {
    const marker = m === best ? '  ★' : '   ';
    const wk = m.estWeekly ? `${(m.estWeekly/1e6).toFixed(1)}M/wk` : 'no weekly';
    const tier = m.quality.tier;
    const spread = m.quality.spread != null ? ` spread=${(m.quality.spread*100).toFixed(0)}%` : '';
    const date = (m.timestamp || '').slice(0, 10);
    const cb = m.cacheBust !== undefined && m.cacheBust !== null ? `cb=${m.cacheBust}` : '';
    console.log(`${marker} ${m.file.padEnd(56)} ${date}  ${tier.padEnd(11)}  q=${m.quality.score.toString().padStart(4)}${spread}  ${cb.padEnd(5)}  ${wk}`);
  }
  if (ms.length > 5) console.log(`     … ${ms.length - 5} older runs hidden`);
  console.log();
}

// ---- Update models.json ----
const models = JSON.parse(fs.readFileSync(MODELS_FILE));
let weeklyUpdates = 0, weeklyUnchanged = 0;
let notesAutogen = 0, notesPreserved = 0, notesUnchanged = 0;
let sourceUpdates = 0;
let cellsTouched = 0;
let cellsSkippedNoSub = 0;
let cellsSkippedNoModelMatch = 0;

const today = new Date().toISOString().slice(0, 10);

console.log('=== Updating data/models.json ===\n');

for (const [key, best] of Object.entries(bestPerPair)) {
  const [plan, measuredModel] = key.split('|');
  const subId = PLAN_MAP[plan];
  if (!subId) {
    console.log(`  ⚠ No subscription mapping for plan "${plan}" — skip`);
    continue;
  }
  if (!best.estWeekly) {
    console.log(`  ⚠ ${plan} / ${measuredModel}: no weekly estimate — skip`);
    continue;
  }

  const matchingModelIds = findMatchingModelIds(measuredModel, models);
  if (matchingModelIds.length === 0) {
    console.log(`  ⚠ ${plan} / ${measuredModel}: no models.json rows match (looking for name starting with "${measuredModel}")`);
    cellsSkippedNoModelMatch++;
    continue;
  }

  for (const modelId of matchingModelIds) {
    const model = models[modelId];
    const sub = model.subscriptions?.[subId];
    if (!sub) { cellsSkippedNoSub++; continue; }

    const oldWeekly = sub.tokensPerWeek;
    const oldNotes = sub.notes;
    const oldSource = sub.source;
    const newWeekly = best.estWeekly;
    const autogenNote = `Measured ${best.timestamp?.split('T')[0]} via ${best.tool}. ${best.numRuns || '?'} runs, ${best.totalTokens?.toLocaleString()} tokens, ${best.consumed5h}% 5h / ${best.consumedWeekly}% weekly consumed.`;
    const newSource = `${REPO_BLOB_BASE}/${best.source}`;

    const isCurated = isCuratedNote(oldNotes);
    const willPreserve = isCurated && !FORCE;

    let newNotes;
    if (willPreserve) {
      const trailerRe = /\s*\[auto-update \d{4}-\d{2}-\d{2}: tokensPerWeek=[^\]]+\]\s*$/;
      const cleaned = (oldNotes || '').replace(trailerRe, '').trimEnd();
      const trailer = ` [auto-update ${today}: tokensPerWeek=${newWeekly.toLocaleString()} from ${best.file}]`;
      newNotes = cleaned + trailer;
    } else {
      newNotes = autogenNote;
    }

    const weeklyChanged = oldWeekly !== newWeekly;
    const sourceChanged = oldSource !== newSource;
    const notesChanged = oldNotes !== newNotes;

    if (DRY_RUN) {
      const tag = willPreserve ? '(curated, preserve+trailer)' : '(autogen, full overwrite)';
      console.log(`  [dry-run] ${modelId.padEnd(28)} / ${subId}`);
      if (weeklyChanged) {
        const pct = oldWeekly ? `(${((newWeekly-oldWeekly)/oldWeekly*100).toFixed(1)}%)` : '';
        console.log(`              weekly: ${(oldWeekly||0).toLocaleString().padStart(15)} → ${newWeekly.toLocaleString().padStart(15)}  ${pct}`);
      } else {
        console.log(`              weekly: ${newWeekly.toLocaleString().padStart(15)} (unchanged)`);
      }
      if (sourceChanged) console.log(`              source → ${newSource.split('/').pop()}`);
      if (notesChanged) console.log(`              notes ${tag}`);
    } else {
      if (weeklyChanged) { sub.tokensPerWeek = newWeekly; weeklyUpdates++; } else weeklyUnchanged++;
      if (sourceChanged) { sub.source = newSource; sourceUpdates++; }
      if (notesChanged) {
        sub.notes = newNotes;
        if (willPreserve) notesPreserved++;
        else notesAutogen++;
      } else notesUnchanged++;
      sub.confidence = best.confidence;
    }
    cellsTouched++;
  }

  console.log(`  ${plan} / ${measuredModel} → ${subId}: ${best.estWeekly.toLocaleString()}/wk  (${best.confidence}, ${best.quality.tier} q=${best.quality.score})  → ${matchingModelIds.length} model rows`);
  for (const modelId of matchingModelIds) console.log(`      ${modelId}`);
  console.log();
}

if (DRY_RUN) {
  console.log(`\n[dry-run] Would touch ${cellsTouched} (model, sub) cells. No changes written.`);
  if (cellsSkippedNoModelMatch > 0) console.log(`          ${cellsSkippedNoModelMatch} measurements had no matching models.json row.`);
} else {
  fs.writeFileSync(MODELS_FILE, JSON.stringify(models, null, 2));
  console.log(`\n✓ Wrote data/models.json`);
  console.log(`    cells touched: ${cellsTouched}`);
  console.log(`    weekly: ${weeklyUpdates} changed, ${weeklyUnchanged} unchanged`);
  console.log(`    notes:  ${notesAutogen} autogen-overwritten, ${notesPreserved} curated (preserved + trailer), ${notesUnchanged} unchanged`);
  console.log(`    source: ${sourceUpdates} updated`);
  if (FORCE) console.log(`    --force: curated-note protection bypassed`);
}
