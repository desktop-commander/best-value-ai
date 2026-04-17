#!/usr/bin/env node
/**
 * Update models.json subscription tokensPerWeek from measurement files.
 * 
 * Reads measurements/*.json, finds the best estimate per plan,
 * and updates data/models.json with measured values.
 * 
 * Usage: node scripts/update-sub-from-measurements.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const MEAS_DIR = path.join(REPO, 'measurements');
const MODELS_FILE = path.join(REPO, 'data', 'models.json');
const DRY_RUN = process.argv.includes('--dry-run');

// Map plan names from measurements → subscription IDs in models.json
const PLAN_MAP = {
  'Plus': { subId: 'chatgpt_plus', monthlyPrice: 20 },
  'Pro': { subId: 'chatgpt_pro', monthlyPrice: 200 },
  'Business': { subId: 'chatgpt_business', monthlyPrice: 30 },
  'Claude Pro': { subId: 'claude_pro', monthlyPrice: 20 },
  'Claude Max': { subId: 'claude_max_5x', monthlyPrice: 100 },
  'Claude Max 5x': { subId: 'claude_max_5x', monthlyPrice: 100 },
  'Claude Max 20x': { subId: 'claude_max_20x', monthlyPrice: 200 },
};

// Normalize messy plan strings to clean names
function normalizePlan(raw) {
  if (!raw) return 'unknown';
  // "wonderwhy.er@gmail.com (Plus)" → "Plus"
  const m = raw.match(/\((\w+)\)$/);
  if (m) return m[1];
  // "Plus ($20/mo)" → "Plus"
  const m2 = raw.match(/^(\w+)\s*\(/);
  if (m2) return m2[1];
  return raw;
}


// Read all measurements
const files = fs.readdirSync(MEAS_DIR).filter(f => f.endsWith('.json'));
const measurements = [];

for (const f of files) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(MEAS_DIR, f)));
    const est = d.estimates || {};
    
    // Get the best daily estimate
    let dailyTokens = est.daily_tokens || est.daily_tokens_effective;
    let weeklyTokens = est.weekly_tokens;
    let confidence = 'low';
    let source = `measurements/${f}`;
    
    // Calculate confidence based on % delta (bigger = less rounding error)
    const consumed5h = d.quota_consumed?.['5h_pct'] || 0;
    const consumedWeekly = d.quota_consumed?.weekly_pct || d.quota_consumed?.weekly_all_pct || 0;
    const maxDelta = Math.max(consumed5h, consumedWeekly);
    
    if (maxDelta >= 10) confidence = 'medium';
    if (maxDelta >= 20) confidence = 'high';
    
    // If we only have 5h estimate, derive daily (but note weekly is binding)
    if (!dailyTokens && est['5h_tokens']) {
      // Can't derive daily from 5h alone — weekly limit is lower
      dailyTokens = null;
    }
    
    measurements.push({
      file: f,
      tool: d.tool,
      plan: normalizePlan(d.plan),
      planRaw: d.plan,
      model: d.model,
      timestamp: d.timestamp,
      numRuns: d.num_runs,
      totalTokens: d.tokens?.total,
      consumed5h,
      consumedWeekly,
      maxDelta,
      est5h: est['5h_tokens'],
      estWeekly: weeklyTokens,
      estDaily: dailyTokens,
      confidence,
      source,
    });
  } catch (e) {
    console.error(`  Skip ${f}: ${e.message}`);
  }
}


// Group by plan and pick the best measurement per plan
const byPlan = {};
for (const m of measurements) {
  if (!m.plan || m.plan === 'unknown') continue;
  if (!byPlan[m.plan]) byPlan[m.plan] = [];
  byPlan[m.plan].push(m);
}

console.log('=== Measurements by plan ===\n');
const bestPerPlan = {};

for (const [plan, ms] of Object.entries(byPlan)) {
  // Sort by maxDelta descending (biggest % change = most reliable)
  ms.sort((a, b) => b.maxDelta - a.maxDelta);
  const best = ms[0];
  bestPerPlan[plan] = best;
  
  console.log(`${plan} (${ms.length} measurements)`);
  for (const m of ms) {
    const marker = m === best ? '  ★' : '   ';
    const daily = m.estDaily ? `${(m.estDaily/1e6).toFixed(1)}M/day` : 'no daily est';
    const weekly = m.estWeekly ? `${(m.estWeekly/1e6).toFixed(1)}M/wk` : '';
    const h5 = m.est5h ? `${(m.est5h/1e6).toFixed(1)}M/5h` : '';
    console.log(`${marker} ${m.file} | Δ5h=${m.consumed5h}% Δwk=${m.consumedWeekly}% | ${weekly || daily} ${h5} | ${m.confidence}`);
  }
  console.log();
}


// Update models.json
const models = JSON.parse(fs.readFileSync(MODELS_FILE));
let updates = 0;

console.log('=== Updating models.json ===\n');

for (const [plan, best] of Object.entries(bestPerPlan)) {
  const mapping = PLAN_MAP[plan];
  if (!mapping) {
    console.log(`  ⚠ No mapping for plan "${plan}" — add to PLAN_MAP`);
    continue;
  }
  if (!best.estWeekly) {
    console.log(`  ⚠ ${plan}: no weekly estimate (need weekly % delta for reliable measurement)`);
    continue;
  }
  
  const { subId } = mapping;
  let updated = 0;
  
  for (const [modelId, model] of Object.entries(models)) {
    if (!model.subscriptions?.[subId]) continue;
    const sub = model.subscriptions[subId];
    const old = sub.tokensPerWeek;
    
    if (DRY_RUN) {
      console.log(`  [dry-run] ${modelId}/${subId}: ${(old||0).toLocaleString()} → ${best.estWeekly.toLocaleString()} (${best.confidence})`);
    } else {
      sub.tokensPerWeek = best.estWeekly;
      sub.confidence = best.confidence;
      sub.source = `https://github.com/desktop-commander/best-value-ai/blob/master/${best.source}`;
      sub.notes = `Measured ${best.timestamp?.split('T')[0]} via ${best.tool}. ${best.numRuns || '?'} runs, ${best.totalTokens?.toLocaleString()} tokens, ${best.consumed5h}% 5h / ${best.consumedWeekly}% weekly consumed.`;
    }
    updated++;
    updates++;
  }
  console.log(`  ${plan} → ${subId}: ${best.estWeekly.toLocaleString()}/week (${best.confidence}) — updated ${updated} models`);
}

if (!DRY_RUN && updates > 0) {
  fs.writeFileSync(MODELS_FILE, JSON.stringify(models, null, 2));
  console.log(`\n✓ Updated ${updates} subscription entries in models.json`);
} else if (DRY_RUN) {
  console.log(`\n[dry-run] Would update ${updates} entries. Run without --dry-run to apply.`);
} else {
  console.log('\nNo updates to apply.');
}
