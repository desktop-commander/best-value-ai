#!/usr/bin/env node
/**
 * sync-from-arena.js
 * Scrapes the full Arena leaderboard from arena.ai/leaderboard/text and /code
 * using chrome-cli-proper to read live DOM data (no API needed).
 *
 * SETUP:
 * 1. Open Chrome and navigate to:
 *    https://arena.ai/leaderboard/text
 *    https://arena.ai/leaderboard/code
 *    (wait for both pages to fully load)
 * 2. Run: node scripts/sync-from-arena.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const MODELS_FILE = path.join(DATA_DIR, 'models.json');
const CLI = '/Users/eduardsruzga/work/chrome-cli-proper/cli.js';

const ARENA_TEXT_URL = 'https://arena.ai/leaderboard/text';
const ARENA_CODE_URL = 'https://arena.ai/leaderboard/code';
const AT_SOURCE = 'https://arena.ai/leaderboard/text';
const AC_SOURCE = 'https://arena.ai/leaderboard/code';

// JS injected into the Chrome tab to scrape all table rows
const SCRAPE_JS = `(function() {
  const rows = document.querySelectorAll('table tbody tr');
  if (!rows.length) return JSON.stringify({error: 'no rows — page may still be loading'});
  const data = Array.from(rows).map(row => {
    const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
    const modelCell = cells[2] || '';
    const lines = modelCell.split('\\n').map(l => l.trim()).filter(Boolean);
    const slug = lines[0] || '';
    const provLine = lines[1] || '';
    const [provider] = provLine.split(' · ');
    const scoreCell = cells[3] || '';
    const score = parseInt(scoreCell.split('±')[0].trim()) || null;
    const votes = parseInt((cells[4] || '').replace(/,/g,'')) || null;
    return { slug: slug.trim(), provider: (provider||'').trim(), score, votes };
  }).filter(r => r.slug && r.score);
  return JSON.stringify({count: data.length, models: data});
})()`;

function runCLI(tabId, js) {
  // Use spawnSync to avoid shell quoting issues with multiline JS
  const result = spawnSync('node', [CLI, 'eval', js, String(tabId)], {
    maxBuffer: 10*1024*1024,
    encoding: 'utf8'
  });
  const out = result.stdout || '';
  const err = result.stderr || '';
  if (result.error) throw result.error;
  const match = out.match(/→ ([\s\S]+)/);
  if (!match) throw new Error('No output from cli:\n' + out.substring(0,300) + '\n' + err.substring(0,200));
  return JSON.parse(match[1].trim());
}

function getTabId(url) {
  const out = execSync(`node '${CLI}' find_tab "${url}" 2>&1`, {maxBuffer: 1*1024*1024}).toString();
  const match = out.match(/\[(\d+)\]/);
  if (!match) {
    console.error(`\n❌ Could not find Chrome tab for: ${url}`);
    console.error('   Please open this URL in Chrome first, wait for it to load, then re-run.');
    process.exit(1);
  }
  return parseInt(match[1]);
}

// Our model IDs -> Arena slug patterns (priority order)
const SLUG_MAPPINGS = {
  'claude-opus-4':        ['claude-opus-4-20250514'],
  'claude-sonnet-4':      ['claude-sonnet-4-20250514'],
  'claude-opus-4-5':      ['claude-opus-4-5-20251101'],
  'claude-4-5-sonnet':    ['claude-sonnet-4-5-20250929'],
  'claude-4-5-haiku':     ['claude-haiku-4-5-20251001'],
  'claude-opus-4-6':      ['claude-opus-4-6'],
  'claude-sonnet-4-6':    ['claude-sonnet-4-6'],
  'gpt-5-4':              ['gpt-5.4', 'gpt-5.4-high'],
  'gpt-5-3-codex':        ['gpt-5.3-codex (codex-harness)', 'gpt-5.3-chat-latest'],
  'gpt-5-2':              ['gpt-5.2', 'gpt-5.2-chat-latest-20260210', 'gpt-5.2-high'],
  'gpt-5-2-codex':        ['gpt-5.2-codex'],
  'gpt-4o':               ['chatgpt-4o-latest-20250326', 'gpt-4o-2024-05-13'],
  'o3':                   ['o3-2025-04-16', 'o3'],
  'gemini-2.5-pro':       ['gemini-2.5-pro'],
  'gemini-3-pro':         ['gemini-3-pro'],
  'gemini-3-flash':       ['gemini-3-flash'],
  'gemini-3-1-pro':       ['gemini-3.1-pro-preview'],
  'deepseek-v3':          ['deepseek-v3-0324', 'deepseek-v3'],
  'deepseek-v3.2':        ['deepseek-v3.2'],
  'glm-4.7-flash':        ['glm-4.7-flash'],
  'glm-4.7':              ['glm-4.7'],
  'glm-5':                ['glm-5'],
  'minimax-m2.5':         ['minimax-m2.5'],
  'minimax-m2.7':         ['minimax-m2.7'],
  'kimi-k2.5':            ['kimi-k2.5-thinking', 'kimi-k2.5-instant'],
  'qwen-3-32b':           ['qwq-32b', 'qwen3-32b'],
  'qwen3.5-35b-a3b':      ['qwen3.5-35b-a3b'],
  'qwen3.5-27b':          ['qwen3.5-27b'],
  'qwen3.5-122b-a10b':    ['qwen3.5-122b-a10b'],
  'gemma-4-31b':          ['gemma-4-31b'],
  'gemma-4-26b-a4b':      ['gemma-4-26b-a4b'],
  'llama-3.1-70b':        ['llama-3.1-70b-instruct'],
  'llama-3.1-8b':         ['llama-3.1-8b-instruct'],
  'gpt-oss-120b':         ['gpt-oss-120b'],
};

async function scrapeLeaderboard(url, label) {
  console.log(`\nScraping ${label}...`);
  const tabId = getTabId(url);
  console.log(`  Tab: ${tabId}`);
  const result = runCLI(tabId, SCRAPE_JS);
  if (result.error) {
    console.error(`  ❌ ${result.error}`);
    process.exit(1);
  }
  console.log(`  ✓ ${result.count} models scraped`);
  const bySlug = {};
  for (const m of result.models) bySlug[m.slug] = m;
  return bySlug;
}

async function main() {
  const textData = await scrapeLeaderboard(ARENA_TEXT_URL, 'Arena Text');
  const codeData = await scrapeLeaderboard(ARENA_CODE_URL, 'Arena Code');

  const models = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
  let updated = 0;
  const notFound = [];

  for (const [ourId, model] of Object.entries(models)) {
    const bms = model.benchmarks || {};
    models[ourId].benchmarks = bms;

    const explicit = SLUG_MAPPINGS[ourId] || [];
    const auto = [ourId, ourId.replace(/\./g,'-'), ourId.replace(/-(\d)/g,'.$1')];
    const candidates = [...new Set([...explicit, ...auto])];

    let foundText = null, foundCode = null;
    for (const slug of candidates) {
      if (!foundText && textData[slug]) foundText = textData[slug];
      if (!foundCode && codeData[slug]) foundCode = codeData[slug];
    }

    let changed = false;
    if (foundText) {
      const prev = bms.arena_text?.score;
      bms.arena_text = { score: foundText.score, source: AT_SOURCE };
      delete bms.arena_text._estimated;
      if (prev !== foundText.score) { console.log(`  ${model.name}: text ${prev||'—'} → ${foundText.score}`); changed = true; }
    }
    if (foundCode) {
      const prev = bms.arena_code?.score;
      bms.arena_code = { score: foundCode.score, source: AC_SOURCE };
      delete bms.arena_code._estimated;
      if (prev !== foundCode.score) { console.log(`  ${model.name}: code ${prev||'—'} → ${foundCode.score}`); changed = true; }
    }
    if (bms.arena_elo) { delete bms.arena_elo; changed = true; }
    if (changed) updated++;
    if (!foundText && !foundCode) notFound.push(model.name);
  }

  fs.writeFileSync(MODELS_FILE, JSON.stringify(models, null, 2));
  console.log(`\n✅ Done. Updated: ${updated}`);
  if (notFound.length) {
    console.log(`\n⚠️  No Arena data for (${notFound.length}):`);
    notFound.forEach(n => console.log(`   - ${n}`));
    console.log('\n   Add slug mappings to SLUG_MAPPINGS in this script if needed.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
