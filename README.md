# LLM Value Comparison: Local vs Subscription vs API

**Compare the value of Local Hardware vs Subscriptions vs API pricing**

🔗 **Live tool:** https://desktop-commander.github.io/llm-value-comparison/  
📖 **Article:** [Local LLMs Are Finally Beating the Cloud! — But Are They?](https://wonderwhy-er.medium.com/local-llms-are-finally-beating-the-cloud-but-are-they-51fc0ad0dbd7)  
🏠 **Supported by:** [Desktop Commander](https://desktopcommander.app) — a model-agnostic AI assistant that works with local models, API keys, and subscriptions. This is why we care about this question.

---

## What is this?

A tool to calculate and compare **quality-adjusted tokens per dollar** across three ways to access LLMs:

1. **🖥️ Local** — One-time hardware cost, unlimited usage
2. **💳 Subscription** — Monthly fee, daily token limits (⚠️ estimated)
3. **🔌 API** — Pay per token

The core insight: not all tokens are equal. A token from a smarter model is worth more. We multiply raw token counts by model quality (from benchmarks) to get a fair comparison across completely different pricing models.

## Why Desktop Commander built this

Desktop Commander supports API keys, local models, and subscriptions to Claude and ChatGPT. Our users ask us constantly: *"What should I use?"* This tool is our answer — and we're keeping it open source so the community can help keep the data accurate.

## Features

* **📊 Calculator** — Ranked comparison of all models/services with step-by-step math
* **📈 Timeline Chart** — Value trends over time by provider
* **📋 Raw Data** — All data in tables with source links for every data point

## Local Development

```bash
# Using npx (recommended)
npx serve

# Or using Python
python3 -m http.server 8888
```

Then open http://localhost:3000 (serve) or http://localhost:8888 (Python).

## The Formula

All three calculate: **Quality-Adjusted Tokens per Dollar**

### Local
```
(tokens/sec × hours/day × 3600 × 365 × years × quality%) / hardware_cost
```

### Subscription
```
(tokens/day × 365 × years × quality%) / (monthly_price × 12 × years)
```

### API
```
(1,000,000 / weighted_price_per_million) × quality%
```

Weighted price = 75% input + 25% output (typical usage ratio).

## Data Sources

Data is pulled from multiple sources automatically and manually. See [DATA_SOURCES.md](DATA_SOURCES.md) for full details.

### Automated (run `node scripts/sync-from-aa.js`)

| Source | What it provides | Auth needed |
|--------|-----------------|-------------|
| [Artificial Analysis](https://artificialanalysis.ai/) | Benchmark scores, API pricing, **API throughput (tok/s)** | Free API key |
| [Arena AI leaderboard](https://api.wulong.dev/arena-ai-leaderboards/v1/) | Arena ELO — human preference ranking (6M+ votes) | None |
| [OpenRouter](https://openrouter.ai/api/v1/models) | API pricing for 300+ models, esp. open-weight models | None |

> **Attribution:** Benchmark and pricing data from [artificialanalysis.ai](https://artificialanalysis.ai/) — required by their free API terms.

### Manual (community PRs)

| Source | What it provides |
|--------|-----------------|
| [SWE-bench](https://www.swebench.com/) | Coding benchmark — real GitHub issues |
| [Aider leaderboard](https://aider.chat/docs/leaderboards/) | Coding benchmark — polyglot real tasks |
| [llama.cpp discussions](https://github.com/ggerganov/llama.cpp/discussions) | Local inference tok/s per hardware config |
| Provider pricing pages | Verify and supplement AA pricing data |
| Community research | Subscription token limits (providers don't publish these) |

### What each field comes from

| Field | Source |
|-------|--------|
| `benchmarks.aa_intelligence` | Artificial Analysis API (auto) |
| `benchmarks.arena_elo` | Arena AI via wulong.dev (auto) |
| `benchmarks.gpqa_diamond` | Artificial Analysis API (auto) |
| `benchmarks.swe_bench` | SWE-bench.com (manual) |
| `benchmarks.aider_polyglot` | Aider leaderboard (manual) |
| `api.inputPer1M` / `outputPer1M` | Artificial Analysis or OpenRouter (auto) |
| `api.tokensPerSecAPI` | Artificial Analysis API (auto) |
| `local.tokensPerSec` | llama.cpp discussions / community (manual) |
| `subscriptions.tokensPerDay` | Community research (manual, often low confidence) |


## Data Structure

```
/data/
  hardware.json        # Hardware specs, prices, sources
  benchmarks.json      # Benchmark metadata
  models.json          # All model data
```

Each model entry contains benchmarks, API pricing (incl. API throughput), local performance, and subscription options — every data point has a source URL.

### Model format

```json
{
  "name": "Model Name",
  "provider": "Provider",
  "releaseDate": "YYYY-MM-DD",
  "modelCard": "https://link-to-model-card",
  "benchmarks": {
    "aa_intelligence": { "score": 72.1, "source": "https://artificialanalysis.ai/models/..." },
    "arena_elo":       { "score": 1486, "source": "https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=text" },
    "swe_bench":       { "score": 80.9, "source": "https://www.swebench.com/" },
    "aider_polyglot":  { "score": 45.5, "source": "https://aider.chat/docs/leaderboards/" }
  },
  "api": {
    "inputPer1M": 3.00,
    "outputPer1M": 15.00,
    "tokensPerSecAPI": 87.4,
    "source": "https://artificialanalysis.ai/models/..."
  },
  "local": {
    "rtx_4090": {
      "tokensPerSec": 45,
      "quantization": "Q4_K_M",
      "vramRequired": 24,
      "source": "https://github.com/ggerganov/llama.cpp/discussions/..."
    }
  },
  "subscriptions": {
    "service_name": {
      "name": "Service Name",
      "monthlyPrice": 20,
      "tokensPerDay": 200000,
      "confidence": "low",
      "notes": "Explanation of estimate",
      "source": "https://..."
    }
  }
}
```

### Subscription confidence levels

| Level | Meaning |
|-------|---------|
| `high` | Official published limits |
| `medium` | Derived from official info |
| `low` | Community estimates, reverse-engineered |

## Running the Data Sync

```bash
# One-time setup: get a free API key at https://artificialanalysis.ai/login
mkdir -p ~/.config/llm-value-comparison
echo "your_aa_key_here" > ~/.config/llm-value-comparison/aa_api_key

# Sync all sources (AA + Arena + OpenRouter)
node scripts/sync-from-aa.js
```

The sync updates: API pricing, AA benchmark scores, Arena ELO, API throughput.  
It does NOT overwrite: local inference data, subscription limits, manually verified fields.

## Contributing

**This project needs community contributions to stay accurate. Data goes stale fast.**

1. Fork the repo
2. Edit `data/models.json` — add or update a model entry
3. Every data point must have a `source` URL
4. Submit a PR

Most needed contributions:
- **Local tok/s benchmarks** — run a model, measure, submit with hardware + quantization + source
- **Subscription token limits** — reverse-engineer or find community data
- **New model entries** — especially smaller/cheaper models and Chinese open-weights

## License

MIT — use it however you want.

---

*Built by [Eduard Ruzga](https://github.com/wonderwhy-er). Supported by [Desktop Commander](https://desktopcommander.app).*
