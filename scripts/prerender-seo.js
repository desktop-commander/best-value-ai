#!/usr/bin/env node
// Pre-render static SEO content into index.html from JSON data
// Run: node scripts/prerender-seo.js
// 
// Reads models.json + hardware.json + benchmarks.json, computes rankings,
// and injects static HTML into index.html that Google can index.
// The client-side JS hydrates on top (replaces the static content).

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const models = JSON.parse(fs.readFileSync(path.join(REPO, 'data/models.json'), 'utf-8'));
const hardware = JSON.parse(fs.readFileSync(path.join(REPO, 'data/hardware.json'), 'utf-8'));
const benchmarks = JSON.parse(fs.readFileSync(path.join(REPO, 'data/benchmarks.json'), 'utf-8'));

// ─────────────────────────────────────────────────────────────────────────
// Derive subscription rows for plans we don't directly measure
// We don't measure ChatGPT Pro ($100, $200) or Claude Max 5×, but providers
// publish multipliers vs their base plans. Whenever a base plan IS measured
// for a given model, we synthesize the derived row from base × multiplier.
//
// The alternative — keeping static estimated rows in models.json — went out
// of sync repeatedly (Pro stuck at 66.5M while Plus updated 13M → 190M).
// Computing here means every prerender automatically refreshes derived rows
// to match the latest base measurement.
//
// Source: OpenAI help center "About ChatGPT Pro tiers"
// (https://help.openai.com/en/articles/9793128) and Anthropic plan docs.
// Multipliers are vendor-stated, not empirically verified — flagged with
// confidence: 'low' and clear "vendor-stated" notes.
// ─────────────────────────────────────────────────────────────────────────
const DERIVED_PLANS = [
  {
    plan_key: 'chatgpt_pro_100',
    name: 'ChatGPT Pro $100',
    monthlyPrice: 100,
    base_plan: 'chatgpt_plus',
    multiplier: 5,
    multiplier_label: '5×',
    source_url: 'https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers',
    notes: 'Pro $100 plan launched Apr 2026. OpenAI states 5× higher weekly limits than Plus (10× Codex usage through May 31, 2026 as a launch promo). We have not measured Pro $100 directly — this row is derived from our Plus measurement × the vendor-stated multiplier. Real number could differ if OpenAI\'s "5×" applies to a dimension other than tokens (e.g. rate-limit slots, message count). Help us verify by running scripts/measure-codex-quota.sh on a Pro $100 account.',
  },
  {
    plan_key: 'chatgpt_pro_200',
    name: 'ChatGPT Pro $200',
    monthlyPrice: 200,
    base_plan: 'chatgpt_plus',
    multiplier: 20,
    multiplier_label: '20×',
    source_url: 'https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers',
    notes: 'Pro $200 plan. OpenAI states 20× higher weekly limits than Plus (with a 25× Codex 5-hour bonus through May 31, 2026). We have not measured Pro $200 directly — this row is derived from our Plus measurement × the vendor-stated multiplier. Real number could differ if "20×" applies to a different dimension than tokens.',
  },
  {
    plan_key: 'claude_max_5x',
    name: 'Claude Max 5×',
    monthlyPrice: 100,
    base_plan: 'claude_max_20x',
    multiplier: 5/20,
    multiplier_label: '5/20',
    source_url: 'https://www.anthropic.com/pricing',
    notes: 'Anthropic\'s Max plans are tiered as 5× and 20× Pro. We measure Max 20×; Max 5× is derived as 5/20 of the measured Max 20× number for the same model. Not directly measured.',
  },
];

let derivedCount = 0;
for (const dp of DERIVED_PLANS) {
  for (const [modelId, model] of Object.entries(models)) {
    const subs = model.subscriptions;
    if (!subs) continue;
    const base = subs[dp.base_plan];
    if (!base || !base.tokensPerWeek) continue;
    // Skip if the base row is itself estimated — don't derive from estimates
    if (base.estimated === true) continue;

    const derivedTpw = Math.round(base.tokensPerWeek * dp.multiplier);
    subs[dp.plan_key] = {
      name: dp.name,
      monthlyPrice: dp.monthlyPrice,
      tokensPerWeek: derivedTpw,
      estimated: true,
      derived: true,
      derived_from: {
        base_plan: dp.base_plan,
        base_tokens_per_week: base.tokensPerWeek,
        base_measured_on_model: base.measuredOnModel || null,
        multiplier: dp.multiplier,
        multiplier_label: dp.multiplier_label,
        source: dp.source_url,
      },
      confidence: 'low',
      notes: dp.notes,
      source: dp.source_url,
    };
    derivedCount++;
  }
}
console.log(`  ✓ Derived ${derivedCount} subscription rows from base × vendor multipliers`);

// Persist derived rows back to data/models.json so the client-side runtime
// (which fetches this file directly) sees the same data the prerender does.
// Source-of-truth rows (chatgpt_plus, chatgpt_business, claude_pro,
// claude_max_20x) are always written by humans / measurement runs; derived
// rows above are recomputed from those each prerender. So this file
// roundtrips: human edits the base measurements, prerender refreshes
// the derived rows, both get committed together.
fs.writeFileSync(
  path.join(REPO, 'data/models.json'),
  JSON.stringify(models, null, 2)
);

// Replicate the scoring logic from index.html
// Z-score normalization
let arenaScores = [], aaScores = [];
Object.values(models).forEach(m => {
  const bm = m.benchmarks || {};
  if (bm.arena_text?.score) arenaScores.push(bm.arena_text.score);
  if (bm.arena_code?.score) arenaScores.push(bm.arena_code.score);
  if (bm.aa_intelligence?.score) aaScores.push(bm.aa_intelligence.score);
});

function stats(arr) {
  const n = arr.length, mean = arr.reduce((a,b) => a+b, 0) / n;
  const std = Math.sqrt(arr.reduce((a,b) => a + (b-mean)**2, 0) / n);
  return { mean, std };
}
const arenaStats = arenaScores.length ? stats(arenaScores) : null;
const aaStats = aaScores.length ? stats(aaScores) : null;

function norm(score, bmId) {
  const bm = benchmarks[bmId];
  if (!bm) return score;
  if (bm.type === 'elo' && arenaStats) return Math.max(0, Math.min(100, 50 + ((score - arenaStats.mean) / arenaStats.std) * 15));
  if (bmId === 'aa_intelligence' && aaStats) return Math.max(0, Math.min(100, 50 + ((score - aaStats.mean) / aaStats.std) * 15));
  return score;
}

function getScore(model) {
  if (!model.benchmarks) return null;
  // Blend only the benchmarks that norm() actually z-score-normalizes.
  // Pooling 17 "stable" benchmarks as raw percentages alongside normalized ones produces wrong rankings:
  // older models with more completed benchmarks (MMLU-Pro, AIME 25 etc. retired from v4) inflate above newer ones.
  const blendIds = ['arena_text', 'arena_code', 'aa_intelligence'];
  let t = 0, c = 0;
  blendIds.forEach(id => {
    if (model.benchmarks[id]) { t += norm(model.benchmarks[id].score, id); c++; }
  });
  return c > 0 ? t / c : null;
}

function fmt(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n/1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(0) + 'K';
  return n.toFixed(0);
}

function wap(api) { return api.inputPer1M * 0.75 + api.outputPer1M * 0.25; }

// Compute all rankings
const HOURS = 16, YEARS = 3;
let results = [];

Object.values(models).forEach(model => {
  const score = getScore(model);
  if (!score) return;
  const np = score;

  // API
  if (model.api && model.api.inputPer1M > 0) {
    const wp = wap(model.api);
    const val = (1_000_000 / wp) * (np / 100);
    results.push({ model: model.name, type: 'API', val, score: np,
      detail: `$${wp.toFixed(2)}/M blended` });
  }

  // Subscriptions
  if (model.subscriptions) {
    Object.values(model.subscriptions).forEach(sub => {
      if (!sub.tokensPerWeek) return;
      const val = (sub.tokensPerWeek * 4 * (np/100)) / sub.monthlyPrice;
      results.push({ model: model.name, type: 'Subscription', val, score: np,
        detail: `${sub.name} · $${sub.monthlyPrice}/mo${sub.estimated ? ' · 📐 est.' : ''}`, subName: sub.name, estimated: sub.estimated });
    });
  }

  // Local (use first available hardware)
  if (model.local) {
    Object.entries(model.local).forEach(([hwId, perf]) => {
      const hw = hardware[hwId];
      if (!hw || !perf.tokensPerSec) return;
      const val = (perf.tokensPerSec * 3600 * HOURS * 365 * YEARS * (np/100)) / hw.price;
      results.push({ model: model.name, type: 'Local', val, score: np,
        detail: `${perf.tokensPerSec} tok/s · ${hw.name}` });
    });
  }
});

results.sort((a, b) => b.val - a.val);

// Find winners
const bestLocal = results.find(r => r.type === 'Local');
const bestSub = results.find(r => r.type === 'Subscription');
const bestApi = results.find(r => r.type === 'API');

// Generate static HTML for the ranked list (top 20)
const top20 = results.slice(0, 20);
const maxVal = top20[0]?.val || 1;
const typeIcon = { API: '🔌', Local: '🖥️', Subscription: '💳' };
const typeColor = { API: '#2557d6', Local: '#1a9e5c', Subscription: '#7033d8' };

let rankedHtml = '';
top20.forEach((r, i) => {
  const pct = Math.max(2, (r.val / maxVal) * 100);
  const name = r.subName ? `${r.subName} → ${r.model}` : r.model;
  rankedHtml += `<div class="rank-row">
    <span class="rank-num" style="color:${i<3 ? typeColor[r.type] : '#9b9ba4'}">#${i+1}</span>
    <span class="rank-type" style="color:${typeColor[r.type]}">${typeIcon[r.type]} ${r.type === 'Subscription' ? 'Sub' : r.type}</span>
    <span class="rank-name" title="${name.replace(/"/g, '&quot;')}">${name}</span>
    <div class="rank-bar-wrap"><div class="rank-bar" style="width:${pct}%;background:${typeColor[r.type]};opacity:0.9">${pct>18?fmt(r.val):''}</div></div>
    <span class="rank-val-out" style="color:${typeColor[r.type]}">${pct<=18?fmt(r.val):''}</span>
    <span class="rank-detail">${r.detail} (${r.score.toFixed(1)}%)</span>
  </div>\n`;
});

// Generate static winner card content
function winnerHtml(winner, label) {
  if (!winner) return '';
  return `<div class="hero-stat-model">${winner.model}</div>
    <div class="hero-stat-detail">${winner.detail}</div>
    <div class="hero-stat-num">${fmt(winner.val)}</div>`;
}

// Generate a hidden SEO text block with key model comparisons
const modelNames = Object.values(models).map(m => m.name).join(', ');
const today = new Date().toISOString().split('T')[0];

let seoText = `<!-- SEO: Pre-rendered ${today} from ${Object.keys(models).length} models -->
<div id="seo-content" style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden">
<h2>Best Value AI Models — ${today}</h2>
<p>Comparing ${Object.keys(models).length} AI models across API pricing, subscriptions, and local hardware.</p>`;

if (bestApi) seoText += `<p>Best API value: ${bestApi.model} at ${bestApi.detail} — ${fmt(bestApi.val)} quality-adjusted tokens per dollar.</p>`;
if (bestSub) seoText += `<p>Best subscription value: ${bestSub.subName || bestSub.model} — ${fmt(bestSub.val)} quality-adjusted tokens per dollar.</p>`;
if (bestLocal) seoText += `<p>Best local value: ${bestLocal.model} (${bestLocal.detail}) — ${fmt(bestLocal.val)} quality-adjusted tokens per dollar.</p>`;

// Add top 10 to SEO text
seoText += `<h3>Top 10 AI Models by Value (Quality-Adjusted Tokens per Dollar)</h3><ol>`;
top20.slice(0, 10).forEach((r, i) => {
  const name = r.subName ? `${r.subName} → ${r.model}` : r.model;
  seoText += `<li>${name} (${r.type}) — ${fmt(r.val)} tok/$ — ${r.detail}</li>`;
});
seoText += `</ol>`;

// Add model list for SEO
seoText += `<h3>All Models Compared</h3><p>${modelNames}</p>`;
seoText += `</div>`;

// Now inject into index.html
let html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf-8');

// Remove any existing SEO content blocks first (prevent duplication on re-runs)
html = html.replace(/<!-- SEO:[\s\S]*?<\/div>\n?/g, '');
html = html.replace(/<div id="seo-content"[\s\S]*?<\/div>\n?/g, '');

// 1. Replace ranked list content inside calculatorContent div
// Strategy: find the opening tag, then find its matching closing </div> by counting nesting
const openTag = '<div class="rank-list" id="calculatorContent">';
const openIdx = html.indexOf(openTag);
if (openIdx >= 0) {
  const contentStart = openIdx + openTag.length;
  // Find the matching closing </div> by counting nested divs
  let depth = 0, searchPos = contentStart;
  let closePos = -1;
  while (searchPos < html.length) {
    const nextOpen = html.indexOf('<div', searchPos);
    const nextClose = html.indexOf('</div>', searchPos);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      searchPos = nextOpen + 4;
    } else {
      if (depth === 0) {
        closePos = nextClose;
        break;
      }
      depth--;
      searchPos = nextClose + 6;
    }
  }
  if (closePos >= 0) {
    html = html.substring(0, contentStart) + rankedHtml + html.substring(closePos);
    console.log('  Replaced ranked list content');
  } else {
    console.log('  ⚠ Could not find closing </div> for calculatorContent');
  }
} else {
  console.log('  ⚠ Could not find calculatorContent div');
}

// 2. Inject winner card static content
if (bestLocal) {
  html = html.replace(
    '<div class="hero-stat-model" id="winLocalModel">—</div>',
    `<div class="hero-stat-model" id="winLocalModel">${bestLocal.model}</div>`
  );
  html = html.replace(
    '<div class="hero-stat-num" id="winLocalScore">—</div>',
    `<div class="hero-stat-num" id="winLocalScore">${fmt(bestLocal.val)}</div>`
  );
}
if (bestSub) {
  html = html.replace(
    '<div class="hero-stat-model" id="winSubModel">—</div>',
    `<div class="hero-stat-model" id="winSubModel">${bestSub.model}</div>`
  );
  html = html.replace(
    '<div class="hero-stat-num" id="winSubScore">—</div>',
    `<div class="hero-stat-num" id="winSubScore">${fmt(bestSub.val)}</div>`
  );
}
if (bestApi) {
  html = html.replace(
    '<div class="hero-stat-model" id="winApiModel">—</div>',
    `<div class="hero-stat-model" id="winApiModel">${bestApi.model}</div>`
  );
  html = html.replace(
    '<div class="hero-stat-num" id="winApiScore">—</div>',
    `<div class="hero-stat-num" id="winApiScore">${fmt(bestApi.val)}</div>`
  );
}

// 3. Inject SEO text block before closing </body>
html = html.replace('</body>', seoText + '\n</body>');

// 4. Update the "Updated automatically" tag with actual date
html = html.replace(
  /Updated automatically · \w+ \d{4}/,
  `Updated automatically · ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`
);

// 4b. Inject current year into title, meta description, and H1 sub for SEO freshness
//     (but NOT in URL slug — those stay stable)
const currentYear = new Date().getFullYear();
html = html.replace(
  /<title>Best Value AI: Local vs API vs Subscription — Compare \d+\+ LLMs<\/title>/,
  `<title>Best Value AI ${currentYear}: Local vs API vs Subscription — Compare ${Object.keys(models).length}+ LLMs</title>`
);
html = html.replace(
  /<meta name="description" content="Should you run a local LLM[^"]+"/,
  `<meta name="description" content="Should you run a local LLM, pay per token via API, or subscribe to ChatGPT Plus or Claude Max? Compare ${Object.keys(models).length}+ AI models by quality-adjusted tokens per dollar. Updated ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}."`
);

// Pre-render measurement results table
const MEAS_DIR = path.join(REPO, 'measurements');
const measFiles = fs.readdirSync(MEAS_DIR).filter(f => f.endsWith('.json'));
const measByPlan = {};
for (const f of measFiles) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(MEAS_DIR, f)));
    let plan = d.plan || 'unknown';
    const pm = plan.match(/\((\w+)\)$/); if (pm) plan = pm[1];
    const pm2 = plan.match(/^(\w[\w\s]*?)\s*\(/); if (pm2) plan = pm2[1];
    if (plan === 'Claude Max') plan = 'Claude Max 20x';
    const est = d.estimates || {};
    const d5 = d.quota_consumed?.['5h_pct'] || 0;
    const dw = d.quota_consumed?.weekly_pct || d.quota_consumed?.weekly_all_pct || 0;
    const delta = Math.max(d5, dw);
    if (!measByPlan[plan]) measByPlan[plan] = [];
    measByPlan[plan].push({ file: f, plan, tool: d.tool, model: d.model, ts: d.timestamp, est5h: est['5h_tokens'], estWeekly: est.weekly_tokens, estDaily: est.daily_tokens || est.daily_tokens_effective, delta, d5, dw, runs: d.num_runs, tokens: d.tokens?.total });
  } catch(e) {}
}

// Build table HTML — show best measurement per plan, plus model, plus count of runs available
let measHtml = '<table style="width:100%;border-collapse:collapse;font-size:0.72rem;color:var(--text)"><thead><tr style="border-bottom:1px solid var(--border);text-align:left"><th style="padding:0.35rem">Plan</th><th>Model</th><th>Tool</th><th>Date</th><th>Files</th><th>Task runs</th><th>Quota used</th><th>5h window</th><th>Weekly est</th></tr></thead><tbody>';
for (const [plan, ms] of Object.entries(measByPlan).sort()) {
  ms.sort((a, b) => b.delta - a.delta);
  const b = ms[0];
  const h5 = b.est5h ? `${(b.est5h/1e6).toFixed(1)}M` : '—';
  const daily = b.estDaily ? `${(b.estDaily/1e6).toFixed(1)}M` : '—';
  const weekly = b.estWeekly ? `${(b.estWeekly/1e6).toFixed(0)}M` : '—';
  const dt = b.ts ? b.ts.split('T')[0] : '?';
  const tool = b.tool === 'codex-cli' ? 'Codex' : b.tool === 'claude-code' ? 'Claude' : b.tool;
  // Shorten model string for display
  const model = (b.model || '?').replace(/ \(.*\)$/, '').trim();
  const filesCount = ms.length;
  const taskRuns = b.runs || '?';
  measHtml += `<tr style="border-bottom:1px solid var(--border)"><td style="padding:0.35rem;font-weight:600">${plan}</td><td>${model}</td><td>${tool}</td><td>${dt}</td><td>${filesCount}</td><td>${taskRuns}</td><td>5h:${b.d5}% wk:${b.dw}%</td><td>${h5}</td><td>${weekly}</td></tr>`;
}
measHtml += '</tbody></table>';

// Replace measurement results placeholder
// Use a marker comment to safely find the end of the section
const measStart = html.indexOf('<div id="measurementResults"');
const measEnd = html.indexOf('<!-- /measurementResults -->', measStart);
if (measStart !== -1 && measEnd !== -1) {
  const measReplacement = `<div id="measurementResults" class="fade-up" style="max-width:750px;margin:1.5rem auto 0">
        <h4 style="font-size:0.85rem;color:var(--text);margin-bottom:0.75rem;text-align:center">📊 Our measurements</h4>
        ${measHtml}
        <p style="font-size:0.68rem;color:var(--muted);margin-top:0.5rem;text-align:center"><strong>Files</strong> = separate measurement sessions we've run on this plan (variance expected). <strong>Task runs</strong> = how many times the benchmark task ran within the best session shown. <strong>Quota used</strong> = how much of the 5-hour and weekly limits our test consumed (higher = more reliable extrapolation). <a href="https://github.com/desktop-commander/best-value-ai/tree/master/measurements" target="_blank" style="color:var(--blue)">Raw data →</a></p>
    </div>
    <!-- /measurementResults -->`;
  html = html.substring(0, measStart) + measReplacement + html.substring(measEnd + '<!-- /measurementResults -->'.length);
}
console.log(`  ✓ Measurements: ${Object.keys(measByPlan).length} plans from ${measFiles.length} files`);

// Embed measurement timeline data as JS variable for the subscription tokens chart
const measTimeline = [];
for (const f of measFiles) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(MEAS_DIR, f)));
    let plan = d.plan || 'unknown';
    const pm = plan.match(/\((\w+)\)$/); if (pm) plan = pm[1];
    const pm2 = plan.match(/^(\w[\w\s]*?)\s*\(/); if (pm2) plan = pm2[1];
    if (plan === 'Claude Max') plan = 'Claude Max 20x';
    const est = d.estimates || {};
    const weekly = est.weekly_tokens;
    const session = est.session_tokens || est['5h_tokens'];
    if (!weekly && !session) continue;
    measTimeline.push({
      plan,
      model: (d.model || d.captured_model || '').replace(/\s*\(.*\)\s*$/, '').trim() || null,
      date: d.timestamp ? d.timestamp.split('T')[0] : null,
      weekly: weekly || null,
      session: session || null,
      tool: d.tool,
      delta: Math.max(d.quota_consumed?.['5h_pct'] || 0, d.quota_consumed?.weekly_pct || d.quota_consumed?.weekly_all_pct || 0),
    });
  } catch(e) {}
}

// ─────────────────────────────────────────────────────────────────────────
// API-equivalent value for subscriptions
// "How much would the quota your subscription gives you cost at API prices?"
// Inputs per measurement: input tokens, cached input tokens, output tokens,
//   pct of weekly quota consumed. Scaled to 100% weekly, then × 4.33 weeks/mo,
//   priced at model's public API rate (cached at 10% of input — standard
//   OpenAI/Anthropic convention).
// ─────────────────────────────────────────────────────────────────────────
const CACHED_DISCOUNT = 0.10;
const WEEKS_PER_MONTH = 4.33;
// Map measurement-model-string substring → model id in models.json
const SUB_MODEL_MAP = [
  ['gpt-5.5',    'gpt-5-5'],
  ['gpt-5.4',    'gpt-5-4'],
  ['Opus 4.7',   'claude-opus-4-7'],
  ['Opus 4.6',   'claude-opus-4-6'],
  ['Sonnet 4.6', 'claude-sonnet-4-6'],
  ['Sonnet 4.5', 'claude-4-5-sonnet'],
];
const PLAN_PRICES = {
  'Plus': 20, 'ChatGPT Plus': 20,
  'Business': 30, 'ChatGPT Business': 30,
  'ChatGPT Pro': 200,
  'Claude Pro': 20,
  'Claude Max 20x': 200, 'Claude Max': 200,
};
const PLAN_DISPLAY_NAMES = {
  'Plus': 'ChatGPT Plus',
  'Business': 'ChatGPT Business',
  'Claude Max': 'Claude Max 20×',
  'Claude Max 20x': 'Claude Max 20×',
};

const apiValueRows = [];
for (const f of measFiles) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(MEAS_DIR, f)));
    const tokens = d.tokens || {};
    if (!tokens.total) continue;
    const qc = d.quota_consumed || {};
    const wkPct = qc.weekly_pct ?? qc.weekly_all_pct;
    if (!wkPct || wkPct <= 0) continue;

    // Normalize plan
    let plan = d.plan || 'unknown';
    const pm = plan.match(/\((\w+)\)$/); if (pm) plan = pm[1];
    const pm2 = plan.match(/^(\w[\w\s]*?)\s*\(/); if (pm2) plan = pm2[1];
    if (plan === 'Claude Max') plan = 'Claude Max 20x';
    const subPrice = PLAN_PRICES[plan];
    if (!subPrice) continue;

    // Identify model in models.json
    const modelStr = (d.captured_model || d.model || '');
    const mapEntry = SUB_MODEL_MAP.find(([needle]) => modelStr.toLowerCase().includes(needle.toLowerCase()));
    if (!mapEntry) continue;
    const modelObj = models[mapEntry[1]];
    if (!modelObj?.api?.inputPer1M) continue;
    const apiIn = modelObj.api.inputPer1M;
    const apiOut = modelObj.api.outputPer1M;

    const inputRaw = tokens.input || 0;
    const cached = tokens.cached || 0;
    const output = tokens.output || 0;
    const nonCached = Math.max(0, inputRaw - cached);
    const cacheHitRate = inputRaw > 0 ? cached / inputRaw : 0;

    const scale = 100 / wkPct;
    const wkNonCached = nonCached * scale;
    const wkCached = cached * scale;
    const wkOutput = output * scale;

    const wkApiCost = (wkNonCached / 1e6) * apiIn
                    + (wkCached / 1e6) * apiIn * CACHED_DISCOUNT
                    + (wkOutput / 1e6) * apiOut;
    const monthlyApiCost = wkApiCost * WEEKS_PER_MONTH;
    const multiplier = monthlyApiCost / subPrice;

    apiValueRows.push({
      file: f,
      plan,
      planDisplay: PLAN_DISPLAY_NAMES[plan] || plan,
      modelLabel: mapEntry[0],
      modelId: mapEntry[1],
      subPrice,
      wkPct,
      inputRaw, cached, output,
      cacheHitRate,
      apiIn, apiOut,
      wkApiCost,
      monthlyApiCost,
      multiplier,
      date: (d.timestamp || '').split('T')[0],
    });
  } catch(e) {}
}

// Keep only the latest measurement per (plan, model)
const bestApiValue = {};
for (const r of apiValueRows) {
  const key = `${r.plan}|${r.modelId}`;
  if (!bestApiValue[key] || r.file > bestApiValue[key].file) bestApiValue[key] = r;
}
const apiValueSorted = Object.values(bestApiValue).sort((a, b) => b.multiplier - a.multiplier);

// Build the HTML table rows
const fmtDollar = n => n >= 1000 ? `$${(n/1000).toFixed(2)}K` : `$${Math.round(n)}`;
const apiValueTableRows = apiValueSorted.map(r => {
  return `<tr style="border-bottom:1px solid var(--border)">
    <td style="padding:0.4rem;font-weight:600">${r.planDisplay}</td>
    <td style="padding:0.4rem">${r.modelLabel}</td>
    <td style="padding:0.4rem;text-align:right">$${r.subPrice}/mo</td>
    <td style="padding:0.4rem;text-align:right">${fmtDollar(r.monthlyApiCost)}/mo</td>
    <td style="padding:0.4rem;text-align:right;font-weight:600;color:var(--green)">${r.multiplier.toFixed(1)}×</td>
    <td style="padding:0.4rem;text-align:right;color:var(--muted);font-size:0.68rem">${(r.cacheHitRate*100).toFixed(0)}%</td>
  </tr>`;
}).join('\n');

const apiValueHtml = apiValueTableRows
  ? `<table style="width:100%;border-collapse:collapse;font-size:0.78rem;color:var(--text)">
       <thead><tr style="border-bottom:1px solid var(--border);text-align:left">
         <th style="padding:0.4rem">Plan</th>
         <th style="padding:0.4rem">Model measured</th>
         <th style="padding:0.4rem;text-align:right">You pay</th>
         <th style="padding:0.4rem;text-align:right">API-equivalent</th>
         <th style="padding:0.4rem;text-align:right">Multiplier</th>
         <th style="padding:0.4rem;text-align:right" title="Cache hit rate on our standardized task">Cache%</th>
       </tr></thead>
       <tbody>${apiValueTableRows}</tbody>
     </table>`
  : '<p style="font-size:0.8rem;color:var(--muted)">No measurements available yet.</p>';

const apiValueStart = html.indexOf('<!-- apiEquivValue -->');
const apiValueEnd   = html.indexOf('<!-- /apiEquivValue -->');
if (apiValueStart !== -1 && apiValueEnd !== -1) {
  const replacement = `<!-- apiEquivValue -->\n${apiValueHtml}\n`;
  html = html.substring(0, apiValueStart) + replacement + html.substring(apiValueEnd);
}
console.log(`  ✓ API-equivalent value: ${apiValueSorted.length} plan×model combos`);

// Inject into HTML before closing </body>
// First strip any existing MEASUREMENT_TIMELINE scripts (prevent duplicates on re-run)
html = html.replace(/<script>window\.MEASUREMENT_TIMELINE=[^<]*<\/script>\n?/g, '');
const measTimelineJson = JSON.stringify(measTimeline);
html = html.replace('</body>', `<script>window.MEASUREMENT_TIMELINE=${measTimelineJson};</script>\n</body>`);

fs.writeFileSync(path.join(REPO, 'index.html'), html);

// Generate llms.txt — single source of truth is models.json + measurements
// Follows https://llmstxt.org/ spec: H1 title, blockquote summary, linked sections
const BASE_URL = 'https://desktopcommander.app/best-value-ai';
const REPO_URL = 'https://github.com/desktop-commander/best-value-ai';

const top10Lines = results.slice(0, 10).map((r, i) => {
  return `${i + 1}. **${r.model}** (${r.type}) — ${fmt(r.val)} tok/$ · ${r.detail}`;
}).join('\n');

const measurementLines = Object.entries(measByPlan)
  .sort()
  .map(([plan, ms]) => {
    const best = [...ms].sort((a, b) => b.delta - a.delta)[0];
    // Precision tier based on how much of the quota was consumed during the
    // measurement run. Higher consumption = tighter extrapolation. This is
    // NOT the same as the `confidence` field in models.json (which is about
    // whether a plan is directly measured vs extrapolated from another plan).
    const precision = best.delta >= 20 ? 'tight extrapolation' : best.delta >= 10 ? 'moderate extrapolation' : 'wide extrapolation';
    const weekly = best.estWeekly ? `${(best.estWeekly / 1e6).toFixed(1)}M tokens/week` : 'no weekly estimate';
    const dt = best.ts ? best.ts.split('T')[0] : 'unknown date';
    return `- **${plan}**: ${weekly} · ${precision} · measured ${dt} via ${best.tool} (${best.runs || '?'} runs, ${best.d5}%/5h ${best.dw}%/week consumed)`;
  }).join('\n');

const llmsTxt = `# LLM Value Calculator

> Quality-adjusted tokens per dollar across local hardware, subscription plans, and API pricing for ${Object.keys(models).length}+ large language models. Unlike provider-published pricing, subscription token limits are empirically measured by running standardized tasks through Codex CLI and Claude Code and reading quota deltas before and after. All three access modes (local, subscription, API) are expressed on the same scale and directly comparable. Last updated: ${today}.

## Current winners

- **Best subscription**: ${bestSub?.model || 'n/a'} via ${bestSub?.detail || '—'} — ${bestSub ? fmt(bestSub.val) : '—'} tok/$
- **Best API**: ${bestApi?.model || 'n/a'} — ${bestApi ? fmt(bestApi.val) : '—'} tok/$ at ${bestApi?.detail || '—'}
- **Best local**: ${bestLocal?.model || 'n/a'} on ${bestLocal?.detail || '—'} — ${bestLocal ? fmt(bestLocal.val) : '—'} tok/$

## Top 10 models by quality-adjusted value per dollar

${top10Lines}

## Empirical subscription measurements

${measurementLines || '_No measurements yet._'}

Full measurement history: ${REPO_URL}/tree/master/measurements

## How value is calculated

All three formulas produce "quality-adjusted tokens per dollar" and are directly comparable:

- **Subscription**: \`tokens_per_week × 4 × quality_percent / monthly_price\`
- **Local**: \`tokens_per_second × 3600 × hours_per_day × 365 × years × quality_percent / hardware_price\`
- **API**: \`1,000,000 × quality_percent / blended_price_per_million\`

Quality is a z-score normalized blend of three public benchmarks: Arena text ELO (human preference on general tasks), Arena code ELO (human preference on coding), and the Artificial Analysis Intelligence Index (composite of 10 academic evals including MMLU-Pro, GPQA, and LiveCodeBench). Expressed as a 0–100 percentage.

## Data sources

- **API pricing**: Artificial Analysis + provider pricing pages, verified against OpenRouter
- **Quality benchmarks**: Arena AI (text and coding ELO) + Artificial Analysis Intelligence Index
- **Subscription token limits**: empirically measured by running a standardized coding task through the CLI (Codex CLI or Claude Code) and reading the /status quota delta
- **Local inference speed (tokens/second)**: real-world measurements from [Desktop Commander](https://desktopcommander.app) telemetry data — an AI automation platform that records local model × hardware performance from actual user sessions (Ollama, LM Studio, etc.), anonymized
- **Hardware prices**: MSRP, Apple Refurbished store, street prices via bestvaluegpu.com and PCPartPicker

## Important caveats

- Subscription value assumes 100% weekly quota usage. Light users see much lower effective value.
- Local value assumes the chosen hours/day (default 16) and amortization years (default 3). Electricity is not yet included in the calculation (typically $5–$60/month depending on hardware and usage patterns — an RTX 3090 draws ~70W idle, a Mac Mini ~30W under load).
- Entries marked with "est." in the ranking have no direct measurement — Claude Max 5x, ChatGPT Pro, Claude Pro, and Gemini Advanced are estimated from related plans.
- Quality benchmarks (Arena, Artificial Analysis) change methodology occasionally and can shift rankings by 10-20%.

## Main pages

- [LLM Value Calculator (interactive site)](${BASE_URL}/): Ranking, compare tool, timeline charts, raw data tables
- [GitHub repository](${REPO_URL}): Source code, data, measurement scripts

## Data files (JSON, Apache 2.0 licensed — free to use)

- [models.json](${REPO_URL}/blob/master/data/models.json): All ${Object.keys(models).length} models with benchmarks, API pricing, local performance, subscription data
- [hardware.json](${REPO_URL}/blob/master/data/hardware.json): Hardware configurations with prices and VRAM specs
- [benchmarks.json](${REPO_URL}/blob/master/data/benchmarks.json): Quality benchmark scores used for z-score normalization
- [measurements/](${REPO_URL}/tree/master/measurements): Raw JSON output from each Codex CLI or Claude Code measurement run

## Methodology and contributing

- [MEASUREMENT_METHODOLOGY.md](${REPO_URL}/blob/master/MEASUREMENT_METHODOLOGY.md): How subscription quotas are measured
- [CONTRIBUTING.md](${REPO_URL}/blob/master/CONTRIBUTING.md): How humans or AI agents can submit new measurements
- [DATA_SOURCES.md](${REPO_URL}/blob/master/DATA_SOURCES.md): Where benchmark and pricing data comes from
- [Measurement scripts](${REPO_URL}/tree/master/scripts): Bash automation for Codex and Claude Code

## Attribution

If you use this data or host a fork, please credit:
"Data from [LLM Value Calculator](${BASE_URL}/), supported by [Desktop Commander](https://desktopcommander.app)"
`;

fs.writeFileSync(path.join(REPO, 'llms.txt'), llmsTxt);
console.log(`  ✓ Generated llms.txt: ${llmsTxt.split('\n').length} lines`);

// ── Sync data snapshot into the ai-value-advisor skill ──
// The skill ships with a bundled copy of models.json, hardware.json, and
// benchmarks.json so agents can work offline without curl'ing the site.
// Regenerate the snapshot on every prerender run so the bundled data stays
// in sync with what the live site serves. Also bumps snapshot_date in _meta.json.
const SKILL_DATA_DIR = path.join(REPO, 'skills', 'ai-value-advisor', 'data');
if (fs.existsSync(path.dirname(SKILL_DATA_DIR))) {
  fs.mkdirSync(SKILL_DATA_DIR, { recursive: true });
  const dataFiles = ['models.json', 'hardware.json', 'benchmarks.json'];
  for (const f of dataFiles) {
    fs.copyFileSync(path.join(REPO, 'data', f), path.join(SKILL_DATA_DIR, f));
  }
  // Update _meta.json — preserve existing fields, only bump the date
  const metaPath = path.join(SKILL_DATA_DIR, '_meta.json');
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { meta = {}; }
  }
  meta.snapshot_date = today;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  console.log(`  ✓ Synced skill data snapshot: ${dataFiles.length} files + _meta.json (snapshot_date=${today})`);
} else {
  console.log(`  ⚠ skills/ folder not present — skipping ai-value-advisor data sync`);
}

console.log(`Pre-rendered SEO content into index.html:`);
console.log(`  ✓ Ranked list: ${top20.length} models pre-rendered (was "Loading…")`);
console.log(`  ✓ Winners: Local=${bestLocal?.model || 'none'}, Sub=${bestSub?.model || 'none'}, API=${bestApi?.model || 'none'}`);
console.log(`  ✓ SEO text block: ${Object.keys(models).length} models, top 10 listed`);
console.log(`  ✓ Date: ${today}`);
console.log(`\nGoogle will now see model names, prices, and rankings without JS.`);
