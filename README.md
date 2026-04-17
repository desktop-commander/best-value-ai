# LLM Value Comparison: Local vs Subscription vs API

**Quality-adjusted tokens per dollar — one number to compare local hardware, subscriptions, and API pricing.**

🔗 **Live tool:** https://desktop-commander.github.io/llm-value-comparison/
📖 **Article:** [Local LLMs Are Finally Beating the Cloud! — But Are They?](https://wonderwhy-er.medium.com/local-llms-are-finally-beating-the-cloud-but-are-they-51fc0ad0dbd7)
🏠 **Supported by:** [Desktop Commander](https://desktopcommander.app) — model-agnostic AI that works with local models, API keys, and subscriptions.

---

## What is this?

A tool to calculate and compare **quality-adjusted tokens per dollar** across three ways to access LLMs:

1. **🖥️ Local** — One-time hardware cost, unlimited usage
2. **💳 Subscription** — Monthly fee, daily token limits (⚠️ estimated)
3. **🔌 API** — Pay per token

The core insight: not all tokens are equal. A token from a smarter model is worth more. We multiply raw token counts by a **quality score** — a z-score-normalized blend of Arena text ELO, Arena code ELO, and Artificial Analysis Intelligence Index — to get a fair comparison across completely different pricing models.

## Use the data

All data is open JSON — fetch directly, no API key needed:

| File | URL |
|------|-----|
| Models (pricing, benchmarks, local perf, subscriptions) | [`models.json`](https://desktop-commander.github.io/llm-value-comparison/data/models.json) |
| Hardware (GPUs, Macs, prices) | [`hardware.json`](https://desktop-commander.github.io/llm-value-comparison/data/hardware.json) |
| Benchmark definitions | [`benchmarks.json`](https://desktop-commander.github.io/llm-value-comparison/data/benchmarks.json) |

**Attribution:** If you use this data, please credit: *"Data from [LLM Value Comparison](https://desktop-commander.github.io/llm-value-comparison/), supported by [Desktop Commander](https://desktopcommander.app)"*

## Features

* **🏆 Winner cards** — Best value in each category, auto-calculated, no config needed
* **📊 Calculator** — Ranked comparison with step-by-step math, adjustable I/O ratio
* **⚔️ Compare** — Side-by-side model comparison with bar charts
* **📈 Timeline** — Value trends over time by provider
* **📏 Benchmarks** — Explainer on why we use Arena ELO + AA Intelligence (z-score normalized)
* **📋 Raw data** — All data in tables with source links

## Quality scoring

We use **z-score normalized** Arena ELO + AA Intelligence Index as the quality metric. These are the only two benchmarks that remain comparable across model generations (2023→2026). Task-specific benchmarks (SWE-bench, Aider, etc.) are shown in raw data but not used in the main value calculation — they can't fairly compare GPT-3.5-era models with GPT-5.4-era models.

See the [Benchmarks section](https://desktop-commander.github.io/llm-value-comparison/#benchmarks) on the live site for the full explanation.

## Data sources

All data is synced from multiple sources. See [DATA_SOURCES.md](DATA_SOURCES.md) for full details.

### Automated sync scripts

| Script | Sources | What it updates |
|--------|---------|-----------------|
| `node scripts/sync-from-aa.js` | [Artificial Analysis](https://artificialanalysis.ai/), [Arena AI](https://arena.ai/), [OpenRouter](https://openrouter.ai/) | API pricing, benchmark scores, Arena ELO, API throughput |
| `node scripts/sync-from-arena.js` | [Arena AI](https://arena.ai/) full leaderboard (338 models) | Arena text + code ELO via Chrome scraping |
| `node scripts/sync-hardware-prices.js` | [bestvaluegpu.com](https://bestvaluegpu.com/), [apple.com](https://apple.com/shop/buy-mac), [Swappa](https://swappa.com/) | GPU prices (HTTP), Mac prices (Playwright + Chrome) |
| `node scripts/import-dc-local-data.js` | DC production database | Local model tok/s with real hardware info |

### Manual (community PRs)

- **Local tok/s benchmarks** — run a model on your hardware, measure, submit with specs
- **Subscription token limits** — measured empirically, see below
- **New model entries** — especially Chinese open-weights and smaller models

### Subscription token measurement

Providers don't publish exact daily token quotas. We measure them empirically:

1. Run a standardized coding task via Codex CLI with `--json` (exact token counts)
2. Read `/status` before and after via tmux (quota percentage change)
3. Calculate: `total_quota = tokens_consumed / (pct_consumed / 100)`

**Scripts:** `scripts/measure-codex-quota.sh` and `scripts/measure-claude-quota.sh`

**First measurement (ChatGPT Plus $20/mo, GPT-5.4 xhigh):**
- 5h window: ~6.6M tokens, Weekly: ~13.3M, Daily: ~1.9M
- Full details: [MEASUREMENT_METHODOLOGY.md](MEASUREMENT_METHODOLOGY.md)

## Running locally

```bash
npx serve
# or
python3 -m http.server 8888
```

## Running data sync

```bash
# One-time: get a free API key at https://artificialanalysis.ai/login
echo "your_key" > ~/.config/llm-value-comparison/aa_api_key

# Sync model data (API pricing, benchmarks, Arena ELO)
node scripts/sync-from-aa.js

# Sync hardware prices (GPUs + Macs)
node scripts/sync-hardware-prices.js

# Sync full Arena leaderboard (requires Chrome tabs open at arena.ai)
node scripts/sync-from-arena.js
```

## Contributing

**This project needs community data to stay accurate.** Fork, edit `data/models.json`, and submit a PR. Every data point must have a `source` URL.

Most needed:
- Local tok/s benchmarks with hardware specs
- Subscription token limit measurements
- New model entries (pricing + benchmarks)

## License

Apache License 2.0 — free to fork, modify, and host. The [NOTICE](NOTICE) file requires any public deployment to credit Desktop Commander with a visible link. See [LICENSE](LICENSE) for full terms.

---

*Built by [Eduard Ruzga](https://github.com/wonderwhy-er). Supported by [Desktop Commander](https://desktopcommander.app).*
