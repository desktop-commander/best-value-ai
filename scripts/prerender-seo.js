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
  const stableIds = Object.entries(benchmarks).filter(([,b]) => b.stable).map(([id]) => id);
  let t = 0, c = 0;
  stableIds.forEach(id => {
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
    const est = d.estimates || {};
    const d5 = d.quota_consumed?.['5h_pct'] || 0;
    const dw = d.quota_consumed?.weekly_pct || d.quota_consumed?.weekly_all_pct || 0;
    const delta = Math.max(d5, dw);
    if (!measByPlan[plan]) measByPlan[plan] = [];
    measByPlan[plan].push({ file: f, plan, tool: d.tool, model: d.model, ts: d.timestamp, est5h: est['5h_tokens'], estWeekly: est.weekly_tokens, estDaily: est.daily_tokens || est.daily_tokens_effective, delta, d5, dw, runs: d.num_runs, tokens: d.tokens?.total });
  } catch(e) {}
}

// Build table HTML — show best measurement per plan
let measHtml = '<table style="width:100%;border-collapse:collapse;font-size:0.72rem;color:var(--text)"><thead><tr style="border-bottom:1px solid var(--border);text-align:left"><th style="padding:0.35rem">Plan</th><th>Tool</th><th>Date</th><th>Runs</th><th>Quota used</th><th>5h window</th><th>Weekly est</th></tr></thead><tbody>';
for (const [plan, ms] of Object.entries(measByPlan).sort()) {
  ms.sort((a, b) => b.delta - a.delta);
  const b = ms[0];
  const h5 = b.est5h ? `${(b.est5h/1e6).toFixed(1)}M` : '—';
  const daily = b.estDaily ? `${(b.estDaily/1e6).toFixed(1)}M` : '—';
  const weekly = b.estWeekly ? `${(b.estWeekly/1e6).toFixed(0)}M` : '—';
  const dt = b.ts ? b.ts.split('T')[0] : '?';
  const tool = b.tool === 'codex-cli' ? 'Codex' : b.tool === 'claude-code' ? 'Claude' : b.tool;
  measHtml += `<tr style="border-bottom:1px solid var(--border)"><td style="padding:0.35rem;font-weight:600">${plan}</td><td>${tool}</td><td>${dt}</td><td>${b.runs || '?'}</td><td>5h:${b.d5}% wk:${b.dw}%</td><td>${h5}</td><td>${weekly}</td></tr>`;
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
        <p style="font-size:0.68rem;color:var(--muted);margin-top:0.5rem;text-align:center">Quota used = how much of the 5-hour and weekly limits our test consumed. Higher % = more reliable estimate. <a href="https://github.com/desktop-commander/best-value-ai/tree/master/measurements" target="_blank" style="color:var(--blue)">Raw data →</a></p>
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
    const est = d.estimates || {};
    const weekly = est.weekly_tokens;
    const session = est.session_tokens || est['5h_tokens'];
    if (!weekly && !session) continue;
    measTimeline.push({
      plan,
      date: d.timestamp ? d.timestamp.split('T')[0] : null,
      weekly: weekly || null,
      session: session || null,
      tool: d.tool,
      delta: Math.max(d.quota_consumed?.['5h_pct'] || 0, d.quota_consumed?.weekly_pct || d.quota_consumed?.weekly_all_pct || 0),
    });
  } catch(e) {}
}
// Inject into HTML before closing </body>
// First strip any existing MEASUREMENT_TIMELINE scripts (prevent duplicates on re-run)
html = html.replace(/<script>window\.MEASUREMENT_TIMELINE=[^<]*<\/script>\n?/g, '');
const measTimelineJson = JSON.stringify(measTimeline);
html = html.replace('</body>', `<script>window.MEASUREMENT_TIMELINE=${measTimelineJson};</script>\n</body>`);

fs.writeFileSync(path.join(REPO, 'index.html'), html);

// Generate llms.txt — single source of truth is models.json + measurements
// Follows https://llmstxt.org/ spec: H1 title, blockquote summary, linked sections
const BASE_URL = 'https://desktop-commander.github.io/best-value-ai';
const REPO_URL = 'https://github.com/desktop-commander/best-value-ai';

const top10Lines = results.slice(0, 10).map((r, i) => {
  return `${i + 1}. **${r.model}** (${r.type}) — ${fmt(r.val)} tok/$ · ${r.detail}`;
}).join('\n');

const measurementLines = Object.entries(measByPlan)
  .sort()
  .map(([plan, ms]) => {
    const best = [...ms].sort((a, b) => b.delta - a.delta)[0];
    const conf = best.delta >= 20 ? 'high' : best.delta >= 10 ? 'medium' : 'low';
    const weekly = best.estWeekly ? `${(best.estWeekly / 1e6).toFixed(1)}M tokens/week` : 'no weekly estimate';
    const dt = best.ts ? best.ts.split('T')[0] : 'unknown date';
    return `- **${plan}**: ${weekly} · ${conf} confidence · measured ${dt} via ${best.tool} (${best.runs || '?'} runs, ${best.d5}%/5h ${best.dw}%/week consumed)`;
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
- **Local inference speed (tokens/second)**: real-world measurements from [Desktop Commander](https://desktopcommander.app) production data — an AI automation platform that records local model × hardware performance from actual user sessions (Ollama, LM Studio, etc.), anonymized
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

console.log(`Pre-rendered SEO content into index.html:`);
console.log(`  ✓ Ranked list: ${top20.length} models pre-rendered (was "Loading…")`);
console.log(`  ✓ Winners: Local=${bestLocal?.model || 'none'}, Sub=${bestSub?.model || 'none'}, API=${bestApi?.model || 'none'}`);
console.log(`  ✓ SEO text block: ${Object.keys(models).length} models, top 10 listed`);
console.log(`  ✓ Date: ${today}`);
console.log(`\nGoogle will now see model names, prices, and rankings without JS.`);
