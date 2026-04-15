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
      if (!sub.tokensPerDay) return;
      const val = (sub.tokensPerDay * 365 * YEARS * (np/100)) / (sub.monthlyPrice * 12 * YEARS);
      results.push({ model: model.name, type: 'Subscription', val, score: np,
        detail: `${sub.name} · $${sub.monthlyPrice}/mo`, subName: sub.name });
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
    <span class="rank-name">${name}</span>
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
let measHtml = '<table style="width:100%;border-collapse:collapse;font-size:0.72rem;color:var(--text)"><thead><tr style="border-bottom:1px solid var(--border);text-align:left"><th style="padding:0.35rem">Plan</th><th>Tool</th><th>Date</th><th>Runs</th><th>Quota used</th><th>5h window</th><th>Daily est</th><th>Confidence</th></tr></thead><tbody>';
for (const [plan, ms] of Object.entries(measByPlan).sort()) {
  ms.sort((a, b) => b.delta - a.delta);
  const b = ms[0];
  const conf = b.delta >= 20 ? '🟢 high' : b.delta >= 10 ? '🟡 medium' : '🔴 low';
  const h5 = b.est5h ? `${(b.est5h/1e6).toFixed(1)}M` : '—';
  const daily = b.estDaily ? `${(b.estDaily/1e6).toFixed(1)}M` : '—';
  const dt = b.ts ? b.ts.split('T')[0] : '?';
  const tool = b.tool === 'codex-cli' ? 'Codex' : b.tool === 'claude-code' ? 'Claude' : b.tool;
  measHtml += `<tr style="border-bottom:1px solid var(--border)"><td style="padding:0.35rem;font-weight:600">${plan}</td><td>${tool}</td><td>${dt}</td><td>${b.runs || '?'}</td><td>5h:${b.d5}% wk:${b.dw}%</td><td>${h5}</td><td>${daily}</td><td>${conf}</td></tr>`;
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
        <p style="font-size:0.68rem;color:var(--muted);margin-top:0.5rem;text-align:center">Quota used = how much of the 5-hour and weekly limits our test consumed. Higher % = more reliable estimate. <a href="https://github.com/desktop-commander/llm-value-comparison/tree/master/measurements" target="_blank" style="color:var(--blue)">Raw data →</a></p>
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
    const daily = est.daily_tokens || est.daily_tokens_effective;
    const session = est.session_tokens || est['5h_tokens'];
    if (!daily && !session) continue;
    measTimeline.push({
      plan,
      date: d.timestamp ? d.timestamp.split('T')[0] : null,
      daily: daily || null,
      session: session || null,
      tool: d.tool,
      delta: Math.max(d.quota_consumed?.['5h_pct'] || 0, d.quota_consumed?.weekly_pct || d.quota_consumed?.weekly_all_pct || 0),
    });
  } catch(e) {}
}
// Inject into HTML before closing </body>
const measTimelineJson = JSON.stringify(measTimeline);
html = html.replace('</body>', `<script>window.MEASUREMENT_TIMELINE=${measTimelineJson};</script>\n</body>`);

fs.writeFileSync(path.join(REPO, 'index.html'), html);

console.log(`Pre-rendered SEO content into index.html:`);
console.log(`  ✓ Ranked list: ${top20.length} models pre-rendered (was "Loading…")`);
console.log(`  ✓ Winners: Local=${bestLocal?.model || 'none'}, Sub=${bestSub?.model || 'none'}, API=${bestApi?.model || 'none'}`);
console.log(`  ✓ SEO text block: ${Object.keys(models).length} models, top 10 listed`);
console.log(`  ✓ Date: ${today}`);
console.log(`\nGoogle will now see model names, prices, and rankings without JS.`);
