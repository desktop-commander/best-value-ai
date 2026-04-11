#!/usr/bin/env node
// Import local model benchmarks from DC production database into models.json and hardware.json
const fs = require('fs');
const path = require('path');

const REPO = '/Users/eduardsruzga/work/llm-value-comparison';
const models = JSON.parse(fs.readFileSync(path.join(REPO, 'data/models.json'), 'utf-8'));
const hardware = JSON.parse(fs.readFileSync(path.join(REPO, 'data/hardware.json'), 'utf-8'));

// Raw DB export — all local model×hardware combos
const DB_DATA = [
  { model: 'lm_studio__gemma-4-26b-a4b-it', gpu: 'NVIDIA GeForce RTX 4090', cpu: 'i9-13900KS', os: 'win32', ram: 63.7, msgs: 1, avg_tps: 1.2 },
  { model: 'lm_studio__google/gemma-4-26b-a4b', gpu: 'Apple M1 Max', cpu: 'M1 Max', os: 'darwin', ram: 64, msgs: 3, avg_tps: 4.4 },
  { model: 'lm_studio__google/gemma-4-26b-a4b', gpu: 'NVIDIA GeForce RTX 3080 Ti', cpu: 'Ryzen 9 9900X3D', os: 'win32', ram: 127.4, msgs: 1, avg_tps: 5.6 },
  { model: 'lm_studio__liquid/lfm2-24b-a2b', gpu: 'NVIDIA GeForce RTX 4090', cpu: 'i9-13900KS', os: 'win32', ram: 63.7, msgs: 2, avg_tps: 42.8 },
  { model: 'lm_studio__qwen3.5-9b-claude-4.6-opus-reasoning-distilled', gpu: 'NVIDIA GeForce RTX 4090', cpu: 'i9-13900KS', os: 'win32', ram: 63.7, msgs: 7, avg_tps: 12.8 },
  { model: 'lm_studio__qwen/qwen3-coder-30b', gpu: 'AMD Radeon RX 7900 XTX', cpu: 'Ryzen 9 3900X', os: 'win32', ram: 63.9, msgs: 6, avg_tps: 2.9 },
  { model: 'ollama__bjoernb/gemma4-e4b-think:latest', gpu: 'NVIDIA GeForce RTX 4060', cpu: 'i7-14700F', os: 'win32', ram: 31.8, msgs: 5, avg_tps: 8.7 },
  { model: 'ollama__deepseek-r1:8b', gpu: 'NVIDIA RTX A3000 Laptop GPU', cpu: 'i7-11850H', os: 'win32', ram: 15.2, msgs: 6, avg_tps: 15.4 },
  { model: 'ollama__gemma3:1b', gpu: 'Intel Iris Xe', cpu: 'i7-1355U', os: 'win32', ram: 15.7, msgs: 8, avg_tps: 4.0 },
  { model: 'ollama__gemma4:31b-cloud', gpu: 'AMD Radeon Pro 5500M', cpu: 'i9-9980HK', os: 'darwin', ram: 64, msgs: 2, avg_tps: 21.9 },
  { model: 'ollama__gemma4:e4b', gpu: 'NVIDIA GeForce RTX 5070', cpu: 'Ryzen 7 5700X', os: 'win32', ram: 31.9, msgs: 15, avg_tps: 9.4 },
  { model: 'ollama__gemma4:latest', gpu: 'NVIDIA GeForce RTX 4090', cpu: 'i9-14900K', os: 'win32', ram: 31.8, msgs: 1, avg_tps: 19.5 },
  { model: 'ollama__qwen3.5:latest', gpu: 'NVIDIA GeForce RTX 4060', cpu: 'i7-14700F', os: 'win32', ram: 31.8, msgs: 6, avg_tps: 6.5 },
  { model: 'ollama__qwen3:1.7b', gpu: 'Apple M2', cpu: 'M2', os: 'darwin', ram: 8, msgs: 5, avg_tps: 9.8 },
  { model: 'ollama__qwen3:4b', gpu: 'Apple M2', cpu: 'M2', os: 'darwin', ram: 8, msgs: 1, avg_tps: 16.3 },
  { model: 'ollama__llama3.2:3b', gpu: 'Intel UHD 615', cpu: 'Core m3-8100Y', os: 'win32', ram: 15.9, msgs: 3, avg_tps: 31.1 },
  { model: 'ollama__command-r:35b', gpu: 'Intel UHD 615', cpu: 'Core m3-8100Y', os: 'win32', ram: 15.9, msgs: 3, avg_tps: 4.4 },
];


// Map DB GPU names to hardware IDs (existing or new)
const GPU_TO_HW = {
  'NVIDIA GeForce RTX 4090': 'rtx_4090',
  'NVIDIA GeForce RTX 5070': 'rtx_5070',
  'NVIDIA GeForce RTX 4060': 'rtx_4060',
  'NVIDIA GeForce RTX 4060 Laptop GPU': 'rtx_4060_laptop',
  'NVIDIA GeForce RTX 3080 Ti': 'rtx_3080_ti',
  'NVIDIA RTX A3000 Laptop GPU': 'rtx_a3000_laptop',
  'AMD Radeon RX 7900 XTX': 'rx_7900_xtx',
  'AMD Radeon Pro 5500M': 'macbook_pro_2019_i9',
  'Apple M1 Max': 'mac_m1_max_64gb',
  'Apple M2': 'mac_m2_8gb',
  'Apple M4': 'mac_m4_24gb',
  'Intel Iris Xe': 'intel_iris_xe_laptop',
  'Intel UHD 615': 'intel_uhd_615_laptop',
  'NVIDIA GeForce GTX 260': null, // too old, skip
};

// New hardware entries to add
const NEW_HARDWARE = {
  rtx_5070: { name: 'RTX 5070', price: 550, vram: 12, year: 2025, source: 'https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5070/' },
  rtx_4060: { name: 'RTX 4060', price: 300, vram: 8, year: 2023, source: 'https://www.nvidia.com/en-us/geforce/graphics-cards/40-series/rtx-4060/' },
  rtx_4060_laptop: { name: 'RTX 4060 Laptop', price: 1200, vram: 8, year: 2023, notes: 'Estimated laptop price with RTX 4060', source: 'https://www.nvidia.com/en-us/geforce/laptops/' },
  rtx_3080_ti: { name: 'RTX 3080 Ti', price: 1200, vram: 12, year: 2021, source: 'https://www.nvidia.com/en-us/geforce/graphics-cards/30-series/rtx-3080-3080ti/' },
  rtx_a3000_laptop: { name: 'RTX A3000 Laptop', price: 1800, vram: 6, year: 2021, notes: 'Workstation laptop GPU', source: 'https://www.nvidia.com/en-us/design-visualization/rtx-a3000/' },
  rx_7900_xtx: { name: 'AMD RX 7900 XTX', price: 950, vram: 24, year: 2022, source: 'https://www.amd.com/en/products/graphics/amd-radeon-rx-7900xtx' },
  macbook_pro_2019_i9: { name: 'MacBook Pro 2019 i9 (64GB)', price: 2800, vram: 64, year: 2019, notes: 'Uses system RAM for inference', source: 'https://www.apple.com/shop/refurbished/mac/macbook-pro' },
  mac_m1_max_64gb: { name: 'Mac M1 Max 64GB', price: 3000, vram: 64, year: 2021, source: 'https://www.apple.com/shop/refurbished/mac/macbook-pro' },
  mac_m2_8gb: { name: 'Mac M2 8GB', price: 1000, vram: 8, year: 2022, source: 'https://www.apple.com/shop/buy-mac/macbook-air' },
  mac_m4_24gb: { name: 'Mac M4 24GB', price: 1600, vram: 24, year: 2024, source: 'https://www.apple.com/shop/buy-mac/macbook-pro' },
  intel_iris_xe_laptop: { name: 'Intel Iris Xe Laptop (16GB)', price: 700, vram: 16, year: 2022, notes: 'CPU inference only, integrated GPU', source: 'https://www.intel.com/content/www/us/en/products/platforms/details/alder-lake-p.html' },
  intel_uhd_615_laptop: { name: 'Intel UHD 615 Laptop (16GB)', price: 400, vram: 16, year: 2018, notes: 'Very low-end CPU inference, Core m3', source: 'https://www.intel.com/content/www/us/en/products/platforms/details/amber-lake-y.html' },
};


// Map DB model IDs to our models.json IDs
// Only map models that already exist in our tool or are close equivalents
const MODEL_MAP = {
  'ollama__gemma4:e4b': 'gemma-4-26b-a4b',          // e4b is the 4-bit quant of 26B A4B
  'ollama__bjoernb/gemma4-e4b-think:latest': 'gemma-4-26b-a4b', // thinking variant of same model
  'lm_studio__google/gemma-4-26b-a4b': 'gemma-4-26b-a4b',
  'lm_studio__gemma-4-26b-a4b-it': 'gemma-4-26b-a4b',
  'ollama__gemma4:latest': 'gemma-4-31b',            // default gemma4 is 31B
  'ollama__gemma4:31b-cloud': 'gemma-4-31b',
  'ollama__qwen3.5:latest': 'qwen3.5-27b',           // default qwen3.5 is 27B
  'lm_studio__qwen/qwen3-coder-30b': 'qwen3.5-27b',  // closest match (30B coder ≈ 27B)
  'ollama__deepseek-r1:8b': null,                      // DeepSeek R1 8B not in tool (distill, different from V3.2)
  'ollama__gemma3:1b': null,                           // too small for comparison tool
  'ollama__qwen3:1.7b': null,                          // too small
  'ollama__qwen3:4b': null,                            // too small
  'ollama__llama3.2:3b': null,                         // too small
  'ollama__command-r:35b': null,                       // Command-R not in tool
  'lm_studio__liquid/lfm2-24b-a2b': null,             // LFM2 not in tool
  'lm_studio__qwen3.5-9b-claude-4.6-opus-reasoning-distilled': null, // distilled model, not standard
  'ollama__qwen3.5:9b': null,                          // 9B variant not in tool
};

const SOURCE = 'https://github.com/desktop-commander/llm-value-comparison#dc-production-data';

// Add new hardware
let hwAdded = 0;
for (const [id, hw] of Object.entries(NEW_HARDWARE)) {
  if (!hardware[id]) {
    hardware[id] = hw;
    hwAdded++;
    console.log(`  + hardware: ${id} (${hw.name})`);
  }
}

// Process each DB entry
let updated = 0, skipped = 0;
for (const entry of DB_DATA) {
  const modelId = MODEL_MAP[entry.model];
  const hwId = GPU_TO_HW[entry.gpu];
  
  if (modelId === null || modelId === undefined) {
    skipped++;
    continue;
  }
  if (!hwId) {
    console.log(`  ? skip unknown GPU: ${entry.gpu}`);
    skipped++;
    continue;
  }
  
  const model = models[modelId];
  if (!model) {
    console.log(`  ? model ${modelId} not in models.json`);
    skipped++;
    continue;
  }
  
  if (!model.local) model.local = {};
  
  // Only update if we have more messages (better data) or entry doesn't exist
  const existing = model.local[hwId];
  if (existing && existing._dcMsgs && existing._dcMsgs >= entry.msgs) {
    console.log(`  = ${modelId} × ${hwId}: existing has ${existing._dcMsgs} msgs, new has ${entry.msgs}, keeping existing`);
    continue;
  }
  
  model.local[hwId] = {
    tokensPerSec: entry.avg_tps,
    quantization: entry.model.includes(':e4b') ? 'e4b (4-bit)' : entry.model.includes(':31b-cloud') ? 'cloud (mixed)' : null,
    vramRequired: entry.gpu.includes('Apple') || entry.gpu.includes('Intel') || entry.gpu.includes('AMD Radeon Pro') ? entry.ram : null,
    source: SOURCE,
    _dcMsgs: entry.msgs,
    _estimated: false,
    notes: `DC production data: ${entry.msgs} messages, ${entry.cpu}, ${entry.os === 'darwin' ? 'macOS' : 'Windows'}`
  };
  // Clean nulls
  if (!model.local[hwId].quantization) delete model.local[hwId].quantization;
  if (!model.local[hwId].vramRequired) delete model.local[hwId].vramRequired;
  
  updated++;
  console.log(`  + ${modelId} × ${hwId}: ${entry.avg_tps} tok/s (${entry.msgs} msgs)`);
}

// Write updated files
fs.writeFileSync(path.join(REPO, 'data/hardware.json'), JSON.stringify(hardware, null, 2));
fs.writeFileSync(path.join(REPO, 'data/models.json'), JSON.stringify(models, null, 2));

console.log(`\nDone: ${hwAdded} hardware added, ${updated} local benchmarks updated, ${skipped} skipped`);
