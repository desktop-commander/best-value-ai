#!/usr/bin/env node
// Parse measurement results and estimate total subscription quota
// Usage: node scripts/estimate-quota.js measurements/claude_measurement_*.json

const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2);
if (files.length === 0) {
  // Find all measurement files
  const dir = path.join(__dirname, '..', 'measurements');
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => {
      files.push(path.join(dir, f));
    });
  }
}

if (files.length === 0) {
  console.log('No measurement files found.');
  console.log('Run: bash scripts/measure-subscription-quota.sh');
  process.exit(0);
}

console.log('=== Subscription Quota Estimates ===\n');

files.forEach(file => {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    console.log(`--- ${path.basename(file)} ---`);
    console.log(`  Tool: ${data.tool}`);
    console.log(`  Plan: ${data.plan}`);
    console.log(`  Time: ${data.timestamp}`);
    console.log(`  Task duration: ${data.task_duration_seconds}s`);
    console.log(`  Output: ${data.output_lines} lines, ${data.output_chars} chars`);

    // Try to extract quota percentages from Claude status text
    if (data.tool === 'claude-code') {
      // Parse /status output for percentage used
      const statusBefore = typeof data.status_before === 'string' ? data.status_before : '';
      const statusAfter = typeof data.status_after === 'string' ? data.status_after : '';
      
      // Look for patterns like "X% of your 5-hour limit" or "X% used"
      const pctBefore = statusBefore.match(/(\d+(?:\.\d+)?)%/);
      const pctAfter = statusAfter.match(/(\d+(?:\.\d+)?)%/);

      if (pctBefore && pctAfter) {
        const before = parseFloat(pctBefore[1]);
        const after = parseFloat(pctAfter[1]);
        const delta = after - before;
        if (delta > 0) {
          console.log(`  Quota used: ${before}% → ${after}% (${delta.toFixed(1)}% consumed)`);
          console.log(`  Estimated 5h window: ${Math.round(data.output_chars / (delta/100))} chars`);
        }
      }

      // Parse /cost output for token counts
      const costBefore = typeof data.cost_before === 'string' ? data.cost_before : '';
      const costAfter = typeof data.cost_after === 'string' ? data.cost_after : '';
      const tokenMatch = costAfter.match(/(\d[\d,]+)\s*(?:tokens?|tok)/i);
      const costMatch = costAfter.match(/\$(\d+\.\d+)/);
      if (tokenMatch) console.log(`  Tokens reported by /cost: ${tokenMatch[1]}`);
      if (costMatch) console.log(`  Cost reported by /cost: $${costMatch[1]}`);
    }

    // Codex measurements with manual percentage entry
    if (data.tool === 'codex-cli') {
      if (data.usage_before_5h_pct !== 'skip' && data.usage_after_5h_pct !== 'skip') {
        const before = parseFloat(data.usage_before_5h_pct);
        const after = parseFloat(data.usage_after_5h_pct);
        const delta = after - before;
        if (delta > 0) {
          console.log(`  5h quota: ${before}% → ${after}% (${delta.toFixed(1)}% consumed)`);
          console.log(`  Estimated 5h window: ${Math.round(data.output_chars / (delta/100))} chars`);
        }
      }
    }

    console.log('');
  } catch (err) {
    console.log(`  Error parsing ${file}: ${err.message}\n`);
  }
});

console.log('To improve accuracy, run the measurement multiple times');
console.log('and share results at: https://github.com/desktop-commander/best-value-ai/issues');
