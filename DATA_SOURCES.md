# Data Sources

This document explains where data comes from and how to update it.

## Automated Sources (run `node scripts/sync-from-aa.js`)

| Source | What it provides | API | Rate limit |
|--------|-----------------|-----|------------|
| [Artificial Analysis](https://artificialanalysis.ai/) | Intelligence benchmarks, API pricing, output speed | Free API (key required) | 1000 req/day |
| [Arena AI leaderboards](https://api.wulong.dev/arena-ai-leaderboards/v1/) | Arena ELO (human preference ranking) | Free, no auth | Unknown |
| [OpenRouter](https://openrouter.ai/api/v1/models) | API pricing for 300+ models (esp. open-weight) | Free, no auth | Generous |

**Attribution required:** All use of Artificial Analysis data must credit https://artificialanalysis.ai/

## Manual Sources (community PRs)

| Source | What it provides | Notes |
|--------|-----------------|-------|
| [SWE-bench](https://www.swebench.com/) | Coding benchmark (real GitHub issues) | No API — check monthly |
| [Aider leaderboard](https://aider.chat/docs/leaderboards/) | Coding benchmark (polyglot) | No API — check monthly |
| [llama.cpp discussions](https://github.com/ggerganov/llama.cpp/discussions) | Local tok/s benchmarks per hardware | Community, hardware-specific |
| [HuggingFace model cards](https://huggingface.co/) | Local model specs, quant info | Per-model |
| Provider pricing pages | Source of truth for first-party API pricing | Verify AA data against these |

## Not Automatable (yet)

| Data | Reason | Workaround |
|------|--------|-----------|
| Subscription token limits | Providers don't publish them | Community reverse-engineering |
| Local tok/s benchmarks | Hardware-specific, no central DB | PRs from community + DC production data |
| SWE-bench scores | No public API | Monthly manual scrape |

## Hardware Prices

No free API exists for GPU/hardware prices. PCPartPicker has an internal API but doesn't make it public. The best reference sources:

| Source | Coverage | Notes |
|--------|----------|-------|
| [bestvaluegpu.com](https://bestvaluegpu.com/) | MSRP + current Amazon + eBay used for NVIDIA/AMD GPUs | URL pattern: `/history/new-and-used-{model}-price-history-and-specs/` |
| [gpudeals.net](https://gpudeals.net/) | Current lowest prices from Amazon & eBay | Per-model pages with MSRP reference |
| [Apple Refurbished Store](https://www.apple.com/shop/refurbished/mac) | Mac/MacBook prices | Use refurbished prices for older models |
| [PCPartPicker](https://pcpartpicker.com/trends/) | Price trends, multi-retailer | No API — browse only |
| [GPU Sniper](https://gpusniper.com/) | Real-time price tracking | Fetches from retailer APIs directly |

**Update frequency:** Quarterly manual check is sufficient — GPU prices change slowly.
**Convention:** GPU-only entries use MSRP or current street price. Mac/laptop entries use full system price (marked with "(full system)" in name). Discontinued GPUs use used/eBay price.

## DC Production Data

Desktop Commander's production database provides real-world local inference benchmarks from actual user sessions. These are stored with hardware info (GPU, CPU, RAM, OS) and measured output tokens per second.

| Source | What it provides | Access |
|--------|-----------------|--------|
| DC App production DB | Local model tok/s + exact hardware combos | `node scripts/import-dc-local-data.js` (requires DB access) |

**Import script:** `scripts/import-dc-local-data.js` — maps DB model×hardware combos to models.json entries. Re-run periodically as more users run local models. All entries are tagged with `source: "DC production data"` and include message count for confidence assessment.

**Arena full leaderboard scraper:** `scripts/sync-from-arena.js` — scrapes the full 338-model Arena leaderboard from Chrome tabs (the free API only has ~60 models). Requires two Chrome tabs open: `arena.ai/leaderboard/text` and `arena.ai/leaderboard/code`.

## Benchmark Glossary

| Field | Source | Type | Notes |
|-------|--------|------|-------|
| `aa_intelligence` | Artificial Analysis | 0-100 index | Combines 10 evals — primary quality signal |
| `arena_elo` | Arena AI (via wulong.dev) | ELO ~1000-1550 | Human preference, 6M+ votes |
| `gpqa_diamond` | via AA | % (0-100) | PhD-level science questions |
| `livecodebench` | via AA | % (0-100) | Coding benchmark |
| `swe_bench` | SWE-bench.com | % (0-100) | Real GitHub issue resolution |
| `aider_polyglot` | Aider | % (0-100) | Multi-language coding |

## Running the Sync

```bash
# One-time setup
mkdir -p ~/.config/llm-value-comparison
echo "your_aa_key_here" > ~/.config/llm-value-comparison/aa_api_key
chmod 600 ~/.config/llm-value-comparison/aa_api_key

# Get AA key at: https://artificialanalysis.ai/login

# Run sync
node scripts/sync-from-aa.js
```

Sync updates: API pricing, AA intelligence scores, Arena ELO.  
It does NOT overwrite: local inference data, subscription limits, manually verified data.
