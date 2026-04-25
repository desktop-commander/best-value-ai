bash scripts/measure-codex-quota.sh /tmp/codex-scratch gpt-5.4 bash scripts/measure-codex-quota.sh /tmp/codex-scratch gpt-5.5

```

If you omit the model, the script runs against whatever default the CLI has configured (but then you can't be sure which model actually got measured — pass the flag).

#### Tuning the run (env vars)

Both scripts accept the same env vars for controlling the measurement:

Env varDefault (Claude / Codex)What it does`TARGET_FLIPS`3 / 3Stop after N × 1% meter crossings. More = more precise, uses more quota.`PARALLEL`10 / 1Concurrent task runs per batch. **Main speed-vs-precision knob.**`TARGET_METERweekly_all_pct_used` / `weekly_pct_left`Which quota meter to watch.`CACHE_BUST`0 / 0Prepend a unique nonce per run. Empirically minimal effect through CLI tools (CLI harness dominates the cached prefix); kept for completeness. See note below.`MAX_BATCHES`40 / —Claude only. Safety ceiling.`NUM_RUNS`— / 30Codex only. Total run budget.

**Sizing** `PARALLEL` **by plan — the key decision.** Each batch should move the weekly meter by about 1%. Less is slow; more collapses multiple flips into one batch and destroys multi-flip resolution.

PlanClaude `PARALLEL`Codex `PARALLEL`Notes**Claude Pro** ($20/mo)2–3n/aSmall quota. We burned all 5h quota on PARALLEL=20 once. Stay low.**Claude Max 5×** ($100)5–10n/aNot yet measured; estimate from 20×**Claude Max 20×** ($200)20–30n/aBig quota, headroom for fast runs**ChatGPT Plus** ($20)n/a3–5Each run ≈ 0.25–0.5% of weekly**ChatGPT Business** ($30/seat)n/a1–3Empirically each run ≈ 0.5–0.8% of weekly; PARALLEL=1 safest**ChatGPT Pro** ($200)n/a15–25Not yet measured

**The warning sign:** if the first batch moves the meter by more than 1% and you see *multiple flips recorded with the same* `cumulative_tokens` *value*, the run is contaminated. Kill with `Ctrl-C`, lower `PARALLEL` by half, retry. (The Codex script prints a ⚠ warning when this happens; the Claude script is more permissive, watch manually.)

**Cache-bust mode (`CACHE_BUST=1`):** prepends a unique nonce per run, attempting to invalidate prompt caching. **Empirically has minimal effect** — confirmed Apr 25 2026 on both providers, cache hit rates stay at 86–100% regardless of this flag. The cached portion is the CLI's system prompt + tool definitions (~380K tokens of harness), which user prompts can't reach. So the high cache rates we see in measurements aren't an artifact of our repetitive task — that's just how Codex and Claude Code work for everyone. The flag is kept in case future CLI versions expose explicit cache control; for now it's mostly a no-op.

#### Full examples
```
