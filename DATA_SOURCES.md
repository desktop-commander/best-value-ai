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
| Local tok/s benchmarks | Hardware-specific, no central DB | PRs from community |
| SWE-bench scores | No public API | Monthly manual scrape |

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
