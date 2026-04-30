#!/usr/bin/env node
// build-measurement-timeline.js
//
// Regenerates the MEASUREMENT_TIMELINE array embedded in index.html from the
// raw JSON files in measurements/. Run after each new measurement run, or
// wire into the prerender step.
//
// What it does:
// 1. Reads every *.json in measurements/ (skips .archive/)
// 2. For each file, emits {plan, model, date, weekly, session, tool, delta}
//    matching the shape the chart expects
// 3. Replaces the existing window.MEASUREMENT_TIMELINE=[...] block in
//    index.html with the freshly generated array
//
// Field mapping:
//   plan          ← j.plan, normalized:
//                       "Claude Max"          → "Claude Max 20x"  (default Max variant)
//                       "Claude Max 5x"       → "Claude Max 5x"
//                       "Claude Max 20x"      → "Claude Max 20x"
//                       "Claude Pro"          → "Claude Pro"
//                       "Plus" / "Business"   → unchanged
//   model         ← j.model, normalized to short form:
//                       "gpt-5.5 (reasoning xhigh, summaries auto)" → "gpt-5.5"
//                       "Sonnet 4.6" → "Sonnet 4.6"  (already short)
//   date          ← j.timestamp[:10]  (YYYY-MM-DD)
//   weekly        ← j.estimates.weekly_tokens || null
//   session       ← j.estimates.session_tokens || null
//   tool          ← j.tool
//   delta         ← j.quota_consumed.weekly_all_pct || j.quota_consumed.weekly_pct || 0

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MEASUREMENTS_DIR = path.join(ROOT, 'measurements');
const INDEX_HTML = path.join(ROOT, 'index.html');

function normalizePlan(plan) {
  if (!plan) return 'unknown';
  let p = String(plan).trim();

  // Strip parenthetical annotations: "Plus ($20/mo)" → "Plus", "wonderwhy.er@gmail.com (Plus)" extract "Plus"
  // First case: trailing parens like "(...)" → check what's inside; if it's a known plan keyword, USE that
  const parenMatch = p.match(/\(([^)]+)\)/);
  if (parenMatch) {
    const inside = parenMatch[1].trim();
    // If parens contain a plan keyword, that's the real plan
    if (/\b(Plus|Business|Pro|Max)\b/i.test(inside)) {
      p = inside;
    } else {
      // Otherwise just strip the parens content
      p = p.replace(/\s*\([^)]*\)\s*/g, '').trim();
    }
  }

  // Strip account-prefix patterns like "wonderwhy.er@gmail.com Plus" → "Plus"
  // Match if the whole string contains an email-or-username followed by a plan word
  const accountMatch = p.match(/(?:^|\s)(Plus|Business|Pro|Max(?:\s*\d+x)?|Claude\s+(?:Pro|Max(?:\s*\d+x)?))\b/i);
  if (accountMatch && accountMatch[1] !== p) {
    p = accountMatch[1];
  }

  // Bare "Claude Max" → assume 20x (most common variant in our data)
  if (/^Claude\s+Max$/i.test(p)) return 'Claude Max 20x';

  // Capitalize standard variants
  const lower = p.toLowerCase();
  if (lower === 'plus') return 'Plus';
  if (lower === 'business') return 'Business';
  if (lower === 'pro') return 'Pro';

  return p;
}

function normalizeModel(model) {
  if (!model) return 'unknown';
  const m = String(model).trim();
  // Strip codex-style annotations: "gpt-5.5 (reasoning xhigh, summaries auto)" → "gpt-5.5"
  return m.replace(/\s*\(.*\)\s*$/, '').trim();
}

function entryFromMeasurement(j) {
  const plan = normalizePlan(j.plan);
  const model = normalizeModel(j.model);
  const ts = j.timestamp || '';
  const date = ts.slice(0, 10);
  const ests = j.estimates || {};

  // Compute weekly from per_1% × 100 (the cleaner extrapolation we use in analysis).
  // Fall back to estimates.weekly_tokens for older runs that don't have per_1pct
  // (e.g. coarse single-step measurements where flip-delta wasn't extracted).
  const per1pct = ests.target_meter_mean_tokens_per_1pct || ests.target_meter_median_tokens_per_1pct || null;
  let weekly = null;
  let weekly_method = null;
  if (per1pct && typeof per1pct === 'number' && per1pct > 0) {
    weekly = Math.round(per1pct * 100);
    weekly_method = 'per_1pct_x_100';
  } else if (ests.weekly_tokens) {
    weekly = ests.weekly_tokens;
    weekly_method = 'estimates_weekly_tokens';
  }

  const session = ests.session_tokens || null;
  const tool = j.tool || 'unknown';
  const consumed = j.quota_consumed || {};
  const delta = consumed.weekly_all_pct || consumed.weekly_pct || 0;

  // The chart's y-axis is "tokens/week (estimated)" — plotting session-only
  // entries on the same axis is misleading (session is 5-hour bucket, weekly
  // is 7-day bucket; they're not comparable units). Drop entries that don't
  // have a usable weekly extrapolation. The runs themselves stay in
  // measurements/ for the article and methodology references; they're just
  // not chart-eligible.
  if (!weekly) return null;
  if (!date) return null;

  return { plan, model, date, weekly, session, tool, delta, weekly_method };
}

function readMeasurements() {
  if (!fs.existsSync(MEASUREMENTS_DIR)) {
    console.error(`No measurements directory at ${MEASUREMENTS_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(MEASUREMENTS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();
  const entries = [];
  let skipped = 0;
  for (const f of files) {
    const fp = path.join(MEASUREMENTS_DIR, f);
    let j;
    try {
      j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (e) {
      console.warn(`  skip ${f}: not valid JSON (${e.message})`);
      skipped++;
      continue;
    }
    const entry = entryFromMeasurement(j);
    if (!entry) {
      skipped++;
      continue;
    }
    entries.push(entry);
  }
  // Sort by date ascending so chart points are chronological
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return { entries, total: files.length, skipped };
}

function injectIntoHtml(entries) {
  const html = fs.readFileSync(INDEX_HTML, 'utf-8');
  const json = JSON.stringify(entries);
  const block = `<script>window.MEASUREMENT_TIMELINE=${json};</script>`;

  const re = /<script>window\.MEASUREMENT_TIMELINE=\[[\s\S]*?\];<\/script>/;
  if (!re.test(html)) {
    console.error('ERROR: existing MEASUREMENT_TIMELINE script block not found in index.html');
    console.error('  Expected pattern: <script>window.MEASUREMENT_TIMELINE=[...];</script>');
    process.exit(1);
  }
  const updated = html.replace(re, block);
  fs.writeFileSync(INDEX_HTML, updated, 'utf-8');
}

function main() {
  console.log('=== build-measurement-timeline.js ===');
  console.log(`Reading measurements from: ${MEASUREMENTS_DIR}`);
  const { entries, total, skipped } = readMeasurements();
  console.log(`  ${total} files, ${entries.length} usable timeline entries (${skipped} skipped)`);

  // Show distinct (plan, model) pairs and date range for sanity check
  const pairs = new Set();
  let minDate = '9999', maxDate = '0000';
  for (const e of entries) {
    pairs.add(`${e.plan} · ${e.model}`);
    if (e.date < minDate) minDate = e.date;
    if (e.date > maxDate) maxDate = e.date;
  }
  console.log(`  date range: ${minDate} → ${maxDate}`);
  console.log(`  ${pairs.size} distinct plan·model pairs:`);
  for (const p of [...pairs].sort()) console.log(`    ${p}`);

  // Show entries grouped by pair, latest 3 each, for quick sanity check
  console.log('\n  latest entries per pair:');
  const byPair = {};
  for (const e of entries) {
    const k = `${e.plan} · ${e.model}`;
    (byPair[k] = byPair[k] || []).push(e);
  }
  for (const [k, list] of Object.entries(byPair).sort()) {
    const last3 = list.slice(-3);
    const summary = last3.map(e => {
      const val = e.weekly ? `${(e.weekly/1e6).toFixed(1)}M/wk` : `${(e.session/1e6).toFixed(1)}M/sess`;
      const tag = e.weekly_method === 'estimates_weekly_tokens' ? '*' : '';
      return `${e.date}=${val}${tag}`;
    }).join(', ');
    console.log(`    ${k.padEnd(40)} ${summary}`);
  }
  console.log('  (* = weekly fallback to estimates.weekly_tokens, no per_1% available)');

  // Method breakdown
  const methodCounts = entries.reduce((acc, e) => {
    const k = e.weekly_method || (e.session ? 'session_only' : 'none');
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  console.log('\n  weekly_method breakdown:');
  for (const [m, c] of Object.entries(methodCounts).sort((a,b) => b[1]-a[1])) {
    console.log(`    ${m}: ${c}`);
  }

  injectIntoHtml(entries);
  console.log(`\n✓ Updated ${INDEX_HTML} with ${entries.length} timeline entries`);
}

main();
