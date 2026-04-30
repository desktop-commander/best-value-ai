# Best Value AI

**Where should you get your AI tokens from — local GPU, pay-per-token API, or flat-fee subscription?**

🔗 **Live tool:** https://desktopcommander.app/best-value-ai/
📖 **Article:** [Local LLMs Are Finally Beating the Cloud! — But Are They?](https://wonderwhy-er.medium.com/local-llms-are-finally-beating-the-cloud-but-are-they-51fc0ad0dbd7)
🏠 **Supported by:** [Desktop Commander](https://desktopcommander.app) — model-agnostic AI that works with local models, API keys, and subscriptions.

---

## What this answers

Most LLM leaderboards rank models. This tool asks a different question: **given a model, which way of getting tokens is cheapest?** The answer depends on your hardware, your usage, and which plan you already pay for.

We compare three sources of AI tokens on a single axis — **quality-adjusted tokens per dollar**:

1. **🖥️ Local hardware** — one-time cost, unlimited usage (capped by your GPU)
2. **💳 Subscription** — flat monthly fee (ChatGPT Plus/Pro/Business, Claude Pro/Max 5×/20×, etc.), capped by quota
3. **🔌 API** — pay per token, unlimited scale

The same model via Claude Max 20× at $200/mo, via the API at $15/MTok, and via local hardware on an RTX 4090 give wildly different tokens-per-dollar depending on how much you actually use. This tool puts all three on one ranking.

## Why "quality-adjusted"?

Not all tokens are equal — a token from a smarter model is worth more than a token from a weaker one. We multiply raw token counts by a **quality score** — a z-score-normalized blend of Arena text ELO, Arena code ELO, and Artificial Analysis Intelligence Index — so a $0.50/MTok tiny model doesn't beat Claude Opus just because it's cheaper.

## Use the data

All data is open JSON — fetch directly, no API key needed:

| File | URL |
|------|-----|
| Models (pricing, benchmarks, local perf, subscriptions) | [`models.json`](https://desktopcommander.app/best-value-ai/data/models.json) |
| Hardware (GPUs, Macs, prices) | [`hardware.json`](https://desktopcommander.app/best-value-ai/data/hardware.json) |
| Benchmark definitions | [`benchmarks.json`](https://desktopcommander.app/best-value-ai/data/benchmarks.json) |

**Attribution:** If you use this data, please credit: *"Data from [Best Value AI](https://desktopcommander.app/best-value-ai/), supported by [Desktop Commander](https://desktopcommander.app)"*

## Use from AI agents

This repo ships with two **agent skills** usable from Claude Code, Cursor, Codex, Copilot, Windsurf, and 30+ other coding agents via the [skills](https://skills.sh) CLI.

**Install both:**

```bash
npx skills add desktop-commander/best-value-ai
```

**Or pick one:**

```bash
# For: "which AI should I pay for?" recommendations
npx skills add desktop-commander/best-value-ai --skill ai-value-advisor

# For: measuring your own Claude/Codex quota and contributing data
npx skills add desktop-commander/best-value-ai --skill submit-usage-measurement
```

| Skill | Triggers when user says… | What it does |
|-------|--------------------------|--------------|
| [`ai-value-advisor`](skills/ai-value-advisor/SKILL.md) | "which AI is best value", "ChatGPT Plus vs Claude Pro", "best local LLM for my GPU", "is ChatGPT Business worth it" | Reads bundled data, detects user's hardware, asks about use case + usage + budget, recommends best plan/setup with caveats |
| [`submit-usage-measurement`](skills/submit-usage-measurement/SKILL.md) | "measure my Claude Max quota", "benchmark ChatGPT Business", "contribute data to best-value-ai" | Runs the measurement script, validates output, opens a PR to `measurements/` |

`ai-value-advisor` ships with a snapshot of the full dataset (`models.json`, `hardware.json`, `benchmarks.json`) bundled alongside `SKILL.md`. Agents read from these local files — no network call needed, works offline, no failure mode when the site is down. The snapshot is regenerated on every site deploy via `scripts/prerender-seo.js`, so a fresh install gets recent data. The snapshot date is in `skills/ai-value-advisor/data/_meta.json`; if it's more than 30 days old, the skill will tell the user and point them at the live site.

`submit-usage-measurement` doesn't need data at all — it runs the measurement scripts and opens a PR with the results.

## Features

* **🏆 Winner cards** — Best value in each category, auto-calculated, no config needed
* **📊 Calculator** — Ranked comparison with step-by-step math, adjustable I/O ratio
* **⚔️ Compare** — Side-by-side model comparison with bar charts
* **📈 Timeline** — Value trends over time by provider
* **📏 Benchmarks** — Explainer on why we use Arena ELO + AA Intelligence (z-score normalized)
* **📋 Raw data** — All data in tables with source links

## Quality scoring

We use **z-score normalized** Arena ELO + AA Intelligence Index as the quality metric. These are the only two benchmarks that remain comparable across model generations (2023→2026). Task-specific benchmarks (SWE-bench, Aider, etc.) are shown in raw data but not used in the main value calculation — they can't fairly compare GPT-3.5-era models with GPT-5.4-era models.

See the [Benchmarks section](https://desktopcommander.app/best-value-ai/#benchmarks) on the live site for the full explanation.

## Data sources

All data is synced from multiple sources. See [DATA_SOURCES.md](DATA_SOURCES.md) for full details.

### Automated sync scripts

ScriptSourcesWhat it updates`node scripts/sync-from-aa.mjs`[Artificial Analysis](https://artificialanalysis.ai/), [Arena AI](https://arena.ai/), [OpenRouter](https://openrouter.ai/)API pricing, benchmark scores, Arena ELO, API throughput`node scripts/sync-from-arena.mjs`[Arena AI](https://arena.ai/) full leaderboard (338 models)Arena text + code ELO via Chrome scraping`node scripts/sync-hardware-prices.js`[bestvaluegpu.com](https://bestvaluegpu.com/), [apple.com](https://apple.com/shop/buy-mac), [Swappa](https://swappa.com/)GPU prices (HTTP), Mac prices (Playwright + Chrome)

### Manual (community PRs)

- **Local tok/s benchmarks** — run a model on your hardware, measure, submit with specs
- **Subscription token limits** — measured empirically, see below
- **New model entries** — especially Chinese open-weights and smaller models

### Subscription token measurement
Providers don't publish exact token quotas per plan. We measure them empirically:

1. Launch the CLI (Codex or Claude Code) via `tmux`, read `/status` before
2. Run a standardized coding task repeatedly (Python doubly-linked-list + 10 pytest tests) while counting tokens from the CLI's `--json` output
3. Watch the quota meter (`weekly_pct_left` on Codex, `weekly_all_pct_used` on Claude) until it crosses 1% multiple times
4. Record cumulative tokens at each crossing. Ignore the first crossing (unknown starting position inside its 1% bucket). Estimate from the inter-flip deltas.

**Scripts:** `scripts/measure-codex-quota.sh` and `scripts/measure-claude-quota.sh`

**Current reference measurements (multi-flip method, Apr 24 2026):**

PlanModelTokens/weekChatGPT PlusGPT-5.4 (xhigh)\~190MChatGPT PlusGPT-5.5 (xhigh)\~95MChatGPT BusinessGPT-5.4 (xhigh)\~46MChatGPT BusinessGPT-5.5 (xhigh)\~18MClaude Max 20×Sonnet 4.6\~388MClaude Max 20×Opus 4.7\~248MClaude ProSonnet 4.6\~19.6MClaude ProOpus 4.7\~15.6M

Full methodology: [MEASUREMENT_METHODOLOGY.md](MEASUREMENT_METHODOLOGY.md)

#### Running the scripts

Both scripts take the **model name as the second positional argument** (the first is the working directory where the task will write scratch files):

```bash
# Claude Code — measure Sonnet or Opus on whatever Claude plan you have
bash scripts/measure-claude-quota.sh /tmp/claude-scratch sonnet
bash scripts/measure-claude-quota.sh /tmp/claude-scratch opus

# Codex CLI — measure any OpenAI model exposed to your ChatGPT plan
bash scripts/measure-codex-quota.sh /tmp/codex-scratch gpt-5.4 bash scripts/measure-codex-quota.sh /tmp/codex-scratch gpt-5.5

```

If you omit the model, the script runs against whatever default the CLI has configured (but then you can't be sure which model actually got measured — pass the flag).

#### Tuning the run (env vars)

Both scripts accept the same env vars for controlling the measurement:

Env varDefault (Claude / Codex)What it does`TARGET_FLIPS`3 / 3Stop after N × 1% meter crossings. More = more precise, uses more quota.`PARALLEL`10 / 1Concurrent task runs per batch. **Main speed-vs-precision knob.**`TARGET_METERweekly_all_pct_used` / `weekly_pct_left`Which quota meter to watch.`CACHE_BUST`0 / 0Prepend a unique nonce per run. Codex: ~no effect (cache_read stays 86–88%). Claude Code: drops cache_read 92% → 77%. See note below.`MAX_BATCHES`40 / —Claude only. Safety ceiling.`NUM_RUNS`— / 30Codex only. Total run budget.

**Sizing** `PARALLEL` **by plan — the key decision.** Each batch should move the weekly meter by about 1%. Less is slow; more collapses multiple flips into one batch and destroys multi-flip resolution.

PlanClaude `PARALLEL`Codex `PARALLEL`Notes**Claude Pro** ($20/mo)2–3n/aSmall quota. We burned all 5h quota on PARALLEL=20 once. Stay low.**Claude Max 5×** ($100)5–10n/aNot yet measured; estimate from 20×**Claude Max 20×** ($200)20–30n/aBig quota, headroom for fast runs**ChatGPT Plus** ($20)n/a3–5Each run ≈ 0.25–0.5% of weekly**ChatGPT Business** ($30/seat)n/a1–3Empirically each run ≈ 0.5–0.8% of weekly; PARALLEL=1 safest**ChatGPT Pro** ($200)n/a15–25Not yet measured

**The warning sign:** if the first batch moves the meter by more than 1% and you see *multiple flips recorded with the same* `cumulative_tokens` *value*, the run is contaminated. Kill with `Ctrl-C`, lower `PARALLEL` by half, retry. (The Codex script prints a ⚠ warning when this happens; the Claude script is more permissive, watch manually.)

**Cache-bust mode (**`CACHE_BUST=1`**):** prepends a unique nonce per run, attempting to invalidate prompt caching. The two providers behave differently — confirmed Apr 26 2026 with corrected token-bucket accounting:

- **Codex:** cache_read stays at \~86–88% with or without nonces. Nonces don't reach whatever Codex caches.
- **Claude Code:** cache_read drops from \~92% to \~77%. Nonces invalidate part of the cache (likely recent turns), but not the persistent system context.

The portion that stays cached either way is the CLI's own system prompt + tool definitions + prior session turns — content the user prompt sits *after* in the prefix and can't invalidate by changing. Default is off (cache_bust=0) so measurements reflect what real users see; turn on to characterize sensitivity to prompt repetition specifically.

#### Full examples

```bash
# Claude Sonnet on Claude Pro — conservative (Pro has small quota)
```
TARGET_FLIPS=3 PARALLEL=3 \
  bash scripts/measure-claude-quota.sh /tmp/claude-scratch sonnet

# Claude Opus on Max 20× — aggressive (Max has plenty of room)
TARGET_FLIPS=3 PARALLEL=30 \
```
  bash scripts/measure-claude-quota.sh /tmp/claude-scratch opus

# GPT-5.5 on ChatGPT Plus — moderate (Plus moderate quota, 5.5 burns ~2× per token vs 5.4)
TARGET_METER=weekly_pct_left TARGET_FLIPS=3 NUM_RUNS=30 PARALLEL=3 \
  bash scripts/measure-codex-quota.sh /tmp/codex-scratch gpt-5.5

# GPT-5.4 on ChatGPT Business with cache-bust for worst-case data
CACHE_BUST=1 TARGET_METER=weekly_pct_left TARGET_FLIPS=3 NUM_RUNS=15 PARALLEL=2 \
  bash scripts/measure-codex-quota.sh /tmp/codex-scratch gpt-5.4
```

Results are written to `measurements/<tool>_measurement_<timestamp>.json`.

## Running locally

```bash
npx serve
# or
python3 -m http.server 8888
```

## Running data sync
```bash
# One-time: get a free API key at https://artificialanalysis.ai/login
echo "your_key" > ~/.config/best-value-ai/aa_api_key

# Sync model data (API pricing, benchmarks, Arena ELO)
node scripts/sync-from-aa.mjs

# Sync hardware prices (GPUs + Macs)
node scripts/sync-hardware-prices.js

# Sync full Arena leaderboard (requires Chrome tabs open at arena.ai)
node scripts/sync-from-arena.mjs

# After any data change, regenerate SEO content and sync the skill snapshot.
# Always the last step before committing — keeps index.html, llms.txt, and
# skills/ai-value-advisor/data/ all in sync with the latest JSON.
npm run prerender
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
