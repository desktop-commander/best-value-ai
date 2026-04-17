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
| Subscription token limits | Empirically measured via CLI + /status | `scripts/measure-codex-quota.sh` |
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

[Desktop Commander](https://desktopcommander.app) is an AI automation platform that lets AI agents run local tasks on your computer, including running local LLMs via Ollama, LM Studio, and similar tools. When users opt in to usage data, the app records the local model + hardware combinations they run and the measured output tokens per second.

This gives us **real-world inference benchmarks** across a long tail of hardware configurations that no single benchmark site covers — old MacBooks, workstation laptops, mid-range GPUs, mixed CPU+iGPU setups. A user running Qwen3.5 on an RTX 3080 Ti and another running it on a Mac M1 Max both contribute measurements.

| Source | What it provides | Access |
|--------|-----------------|--------|
| DC App production DB | Anonymous local model tok/s + exact hardware combos from real user sessions | `node scripts/import-dc-local-data.js` (requires DB access) |

**Why this is unique:** most local-LLM benchmarks are either synthetic (run by the repo maintainer on their own hardware) or crowdsourced on consumer forums where quantization and settings vary wildly. DC's data comes from actual daily usage across many users, so it reflects real steady-state performance rather than best-case single-run numbers.

**Import script:** `scripts/import-dc-local-data.js` — maps DB model×hardware combos to `models.json` entries. Re-run periodically as more users run local models. All entries include:
- Exact GPU model, CPU, OS, RAM
- Average tokens/second over multiple sessions (`avg_tps`)
- Number of messages measured (`msgs`) for confidence assessment
- Tagged with `source: "DC production data"` in models.json

**Privacy:** Only anonymous hardware specs and performance numbers are imported. No user identifiers, prompts, or model outputs.

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
mkdir -p ~/.config/best-value-ai
echo "your_aa_key_here" > ~/.config/best-value-ai/aa_api_key
chmod 600 ~/.config/best-value-ai/aa_api_key

# Get AA key at: https://artificialanalysis.ai/login

# Run sync
node scripts/sync-from-aa.js
```

Sync updates: API pricing, AA intelligence scores, Arena ELO.  
It does NOT overwrite: local inference data, subscription limits, manually verified data.
