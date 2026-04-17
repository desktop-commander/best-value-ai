#!/usr/bin/env node
// Scrape Apple Mac prices using Playwright (headless Chromium)
// Run: node scripts/scrape-apple-prices.mjs

import { createRequire } from 'module';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const hwPath = join(REPO, 'data/hardware.json');

// Find playwright
let chromium;
try {
  const require = createRequire(import.meta.url);
  chromium = require('playwright').chromium;
} catch {
  const npxPath = execSync(
    'find ~/.npm/_npx -name "playwright" -path "*/node_modules/playwright" -type d 2>/dev/null | head -1',
    { encoding: 'utf-8' }
  ).trim();
  if (!npxPath) throw new Error('Playwright not found. Run: npx playwright install chromium');
  const require2 = createRequire(npxPath + '/index.js');
  chromium = require2(npxPath).chromium;
}

// --- Swappa scraper for older Macs (plain HTTP, no Playwright needed) ---
const https = await import('https');
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.default.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 Best-Value-AI/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Map hardware IDs to Swappa URLs + config matchers
const SWAPPA_CONFIGS = {
  mac_m1_max_64gb: {
    url: 'https://swappa.com/prices/macbook-pro-2021-16',
    configMatch: /M1 Max.*1\s*TB/i,
    label: 'MacBook Pro 2021 16" M1 Max (Swappa used)',
  },
  mac_m2_8gb: {
    url: 'https://swappa.com/prices/macbook-air-2022-13',
    configMatch: /M2.*256/i,
    label: 'MacBook Air 2022 M2 8GB (Swappa used)',
  },
  mac_m3_max_64gb: {
    url: 'https://swappa.com/prices/macbook-pro-late-2023-m3-16',
    configMatch: /M3 Max/i,
    label: 'MacBook Pro Late 2023 16" M3 Max (Swappa used)',
  },
  macbook_pro_2019_i9: {
    url: 'https://swappa.com/prices/macbook-pro-2019-16',
    configMatch: null,
    label: 'MacBook Pro 2019 16" i9 (Swappa used)',
  },
};

const hardware = JSON.parse(readFileSync(hwPath, 'utf-8'));
const today = new Date().toISOString().split('T')[0];

async function scrapePage(page, url) {
  console.log(`  Loading ${url}...`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  
  // Extract structured price data from the rendered page
  return await page.evaluate(() => {
    const text = document.body.innerText;
    // Find all "From $X" prices — these are the key product prices on Apple buy pages
    const fromPrices = [];
    const regex = /From\s+\$([0-9,]+)/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const pos = m.index;
      // Get surrounding context (200 chars before and after)
      const start = Math.max(0, pos - 200);
      const end = Math.min(text.length, pos + 200);
      const context = text.substring(start, end).replace(/\s+/g, ' ');
      fromPrices.push({
        price: parseFloat(m[1].replace(/,/g, '')),
        context
      });
    }
    return { fromPrices, title: document.title };
  });
}

async function main() {
  console.log('=== Apple prices via Playwright ===');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let updated = 0;

  // --- MacBook Pro ---
  const mbpData = await scrapePage(page, 'https://www.apple.com/shop/buy-mac/macbook-pro');
  console.log(`  ${mbpData.title}: ${mbpData.fromPrices.length} "From $X" prices found`);;
  
  // On Apple's buy page, the "From $X" prices appear in order:
  // 1st occurrence = headline price (same as 14")
  // The one near "14-inch" = 14" starting price  
  // The one near "16-inch" = 16" starting price
  // Apple's MBP buy page has "From $X" in this order:
  // [0] hero headline, [1] duplicate, [2] 14-inch selector, [3] 16-inch selector, [4] footer
  // We identify by unique price values — the 14" and 16" have different prices
  const uniquePrices = [...new Set(mbpData.fromPrices.map(p => p.price))].sort((a,b) => a - b);
  let mbp14 = uniquePrices[0] || null;  // lower = 14" base
  let mbp16 = uniquePrices.length > 1 ? uniquePrices[1] : null;  // higher = 16" base
  if (mbp14) console.log(`  → MBP 14" (lowest): $${mbp14}`);
  if (mbp16) console.log(`  → MBP 16" (next): $${mbp16}`);
  // Fallback: if 14" not matched by context, use first "From $" price
  if (!mbp14 && mbpData.fromPrices.length > 0) {
    mbp14 = mbpData.fromPrices[0].price;
    console.log(`  → MBP 14" (fallback first price): $${mbp14}`);
  }

  // --- MacBook Air ---
  const mbaData = await scrapePage(page, 'https://www.apple.com/shop/buy-mac/macbook-air');
  console.log(`  ${mbaData.title}: ${mbaData.fromPrices.length} "From $X" prices found`);
  let mba = null;
  const mbaUnique = [...new Set(mbaData.fromPrices.map(p => p.price))].sort((a,b) => a - b);
  mba = mbaUnique[0] || null;  // lowest = base Air
  if (mba) console.log(`  → MBA: $${mba}`);

  await browser.close();

  // --- Older Macs from Swappa (needs real Chrome via chrome-control, Cloudflare blocks headless) ---
  console.log('\n=== Older Mac prices from Swappa (via chrome-control) ===');
  const CHROME_CLI = '/Users/eduardsruzga/work/chrome-cli-proper/cli.js';

  for (const [hwId, cfg] of Object.entries(SWAPPA_CONFIGS)) {
    try {
      const hw = hardware[hwId];
      if (!hw) { console.log(`  ? ${hwId} not in hardware.json`); continue; }

      console.log(`  Loading ${cfg.url}...`);
      // Open in background tab, wait, scrape, close
      const tabResult = execSync(`node ${CHROME_CLI} new_background_tab "${cfg.url}"`, { encoding: 'utf-8', timeout: 15000 }).trim();
      const tabIdMatch = tabResult.match(/(\d+)/);
      if (!tabIdMatch) { console.log(`  ✗ Failed to open tab for ${hwId}`); continue; }
      const tabId = tabIdMatch[0];

      // Wait for page to render
      await new Promise(r => setTimeout(r, 6000));

      // Write JS to a temp file to avoid shell quoting issues, then eval_file
      const tmpJs = `/tmp/swappa_scrape_${hwId}.js`;
      writeFileSync(tmpJs, `
        (function() {
          var text = document.body.innerText;
          var startMatch = text.match(/Starting price:\\s*\\$([0-9,]+)/i);
          var avgMatch = text.match(/Average price:\\s*\\$([0-9,]+)/i);
          var rows = [];
          document.querySelectorAll('table tr').forEach(function(tr) {
            var cells = Array.from(tr.querySelectorAll('td, th')).map(function(c) { return c.innerText.trim(); });
            if (cells.length >= 2) rows.push(cells.join(' | '));
          });
          return JSON.stringify({
            starting: startMatch ? parseFloat(startMatch[1].replace(/,/g, '')) : null,
            average: avgMatch ? parseFloat(avgMatch[1].replace(/,/g, '')) : null,
            tableRows: rows,
          });
        })()
      `);

      const evalResult = execSync(`node ${CHROME_CLI} eval_file ${tmpJs} ${tabId}`, { encoding: 'utf-8', timeout: 10000 }).trim();

      // Close the tab
      try { execSync(`node ${CHROME_CLI} close_tab ${tabId}`, { timeout: 5000 }); } catch {}

      let data;
      try { data = JSON.parse(evalResult); } catch {
        // Try extracting JSON from result (chrome-cli may wrap it)
        const jsonMatch = evalResult.match(/\{.*\}/s);
        if (jsonMatch) data = JSON.parse(jsonMatch[0]);
        else { console.log(`  ✗ ${hwId}: couldn't parse result`); continue; }
      }

      let price = null;

      // Try to match specific config in storage table
      if (cfg.configMatch && data.tableRows && data.tableRows.length > 0) {
        for (const row of data.tableRows) {
          if (cfg.configMatch.test(row)) {
            const prices = [...row.matchAll(/\$([0-9,]+)/g)].map(m => parseFloat(m[1].replace(/,/g, '')));
            if (prices.length > 0) {
              price = prices[prices.length - 1];
              console.log(`    Matched: "${row.substring(0, 60)}" → $${price}`);
            }
            break;
          }
        }
      }

      if (!price) price = data.starting;
      if (!price) price = data.average;

      if (price) {
        if (price !== hw.price) {
          console.log(`  ✓ ${hwId}: $${hw.price} → $${price} (${cfg.label})`);
          hw.price = price;
          updated++;
        } else {
          console.log(`  = ${hwId}: $${hw.price} unchanged`);
        }
        hw.notes = `${cfg.label}. Checked ${today}.`;
        hw.source = cfg.url;
      } else {
        console.log(`  ? ${hwId}: no price found`);
      }
      hw.lastVerified = today;
    } catch (err) {
      console.log(`  ✗ ${hwId}: ${err.message}`);
    }
  }


  // --- Update hardware.json ---
  // Map scraped prices to hardware entries
  // 14" base = entry-level chip + 24GB unified memory
  // 16" base = Pro chip + 48GB+ unified memory (starting config)
  const updates = {
    mac_m4_24gb: { price: mbp14, note: 'MacBook Pro 14" base config' },
    mac_m4_48gb: { price: mbp16, note: 'MacBook Pro 16" base config' },
  };

  console.log('\n  Updating hardware.json:');
  for (const [hwId, data] of Object.entries(updates)) {
    if (!data.price) { console.log(`  ? ${hwId}: no price scraped`); continue; }
    const hw = hardware[hwId];
    if (!hw) { console.log(`  ? ${hwId}: not in hardware.json`); continue; }
    if (hw.price !== data.price) {
      console.log(`  ✓ ${hwId}: $${hw.price} → $${data.price} (${data.note})`);
      hw.price = data.price;
      updated++;
    } else {
      console.log(`  = ${hwId}: $${hw.price} unchanged`);
    }
    hw.notes = `${data.note}. Scraped from apple.com. Checked ${today}.`;
    hw.source = 'https://www.apple.com/shop/buy-mac/macbook-pro';
    hw.lastVerified = today;
  }

  writeFileSync(hwPath, JSON.stringify(hardware, null, 2));
  console.log(`\nDone: ${updated} Apple prices updated.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
