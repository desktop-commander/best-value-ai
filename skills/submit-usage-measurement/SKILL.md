---

## name: submit-usage-measurement description: Use this skill when the user wants to contribute a subscription quota measurement to the Best Value AI dataset. Specifically — when they say "measure my Claude Max quota", "benchmark ChatGPT Business", "contribute data to best-value-ai", "submit a measurement", or "help me measure how many tokens I actually get on my plan". Runs the standardized measurement script for Claude Code or Codex CLI, captures token/quota data, validates the output, and opens a pull request to desktop-commander/best-value-ai. version: 1.0.0

# Submit Usage Measurement

Walk a contributor through measuring their AI subscription quota using the standardized scripts in this repo, then open a pull request with the results.

## When to Use

Use this skill when the user explicitly wants to **contribute measurement data** — they're a contributor, not a shopper. Signals:

- "I want to measure my Claude Max quota and submit it"
- "Help me benchmark ChatGPT Business and contribute data"
- "Run the quota measurement script and open a PR"
- "I'm on Claude Pro, can you measure how many tokens I get?"

Do NOT use this skill when the user wants to **understand** AI value — that's `ai-value-advisor` in the same repo.

## Prerequisites

Before starting, verify the user has all of these. If any are missing, stop and tell them what to install.

- **For Claude measurements**: `claude-code` CLI installed and logged in with their subscription
- **For Codex measurements**: `codex` CLI installed and logged in with their ChatGPT subscription
- `tmux` installed (the scripts use tmux to drive the interactive TUIs)
- `git` and `gh` (GitHub CLI) installed, with `gh auth status` showing they're authenticated
- Their fork of `desktop-commander/best-value-ai` cloned locally, OR willingness to let `gh` create a fork for them

## What the measurement captures

Each run produces a JSON file in `measurements/` with:

- **Tool + version**: `claude-code 2.1.107` or `codex-cli 0.120.0`
- **Plan + model**: e.g. `Claude Max 20x / Sonnet 4.5`, `ChatGPT Business / gpt-5.4 xhigh`
- **Task run**: a standardized coding task (doubly-linked-list-with-tests by default) repeated N times
- **Token counts**: input (with cached breakout), output, total — from the CLI's own `--json` output
- **Quota before/after**: percentage left in session/5h/weekly windows — captured via `/status` command in TUI
- **Derived estimates**: weekly and daily token budgets extrapolated from consumed percentage

The goal is empirical ground truth for what providers don't publish.

## Workflow

### Step 1 — Confirm scope with the user

Ask:

1. Which tool? (claude-code or codex)
2. Which plan? (Pro, Max 5x, Max 20x, Plus, Pro, Business, etc.)
3. Which model? (if multiple available on their plan)
4. Have they run the measurement before on this exact plan+model combo? (if yes, a second data point is still valuable — averages stabilize the estimate)

### Step 2 — Preflight checks

Run (but do NOT start measuring yet):

```
gh auth status
command -v tmux && command -v git
claude --version   # or: npx codex --version
```

If any check fails, stop and give the user install instructions. Do not proceed.

### Step 3 — Set expectations

Tell the user:

- Measurement takes **5-10 minutes** and will consume a chunk of their weekly quota (maybe 5-10% on Max plans, 15-25% on Plus/Pro).
- The script launches a tmux session and sends keystrokes to their TUI — they'll see activity but shouldn't touch the terminal.
- If something goes wrong mid-run, they can `tmux kill-session -t claude_m_$$` or `codex_m_$$` to clean up.

Ask for explicit go-ahead before running. This consumes their paid quota — don't assume they want to spend it right now.

### Step 4 — Run the script

From the repo root:

**For Claude Code:**

```
bash scripts/measure-claude-quota.sh
```

**For Codex / ChatGPT:**

```
bash scripts/measure-codex-quota.sh
```

Both scripts stream progress to stdout and write the final JSON to `measurements/<tool>_measurement_<YYYYMMDD_HHMMSS>.json`. The script handles tmux session lifecycle, TUI keystrokes, quota captures before/after, and derived estimates.

### Step 5 — Validate the output

Before opening a PR, sanity-check the generated JSON:

1. `tool`, `version`, `plan`, `model` — all populated (not `"unknown"`)
2. `tokens.total` — matches `tokens.input + tokens.output` (within rounding)
3. `quota_before` and `quota_after` — both captured (not null)
4. `quota_consumed` — positive numbers (0% means the script didn't actually measure anything — re-run)
5. `estimates.weekly_tokens` — sanity check against existing measurements (a claim of 1 trillion/week is suspicious)

If any check fails, investigate before submitting. Bad measurements pollute the dataset.

### Step 6 — Commit and open the PR

```
cd /path/to/best-value-ai
# Create a branch named for the plan+date
git checkout -b measure/claude-max-20x-20260417
git add measurements/claude_measurement_*.json
git commit -m "Measure Claude Max 20x on Sonnet 4.5 — 2026-04-17"
gh pr create \
  --repo desktop-commander/best-value-ai \
  --title "Measurement: Claude Max 20x / Sonnet 4.5 (2026-04-17)" \
  --body "Standardized measurement via scripts/measure-claude-quota.sh.

Plan: Claude Max 20x
Model: Sonnet 4.5
Task: doubly-linked-list-with-tests (30 runs)

Key numbers:
- Tokens consumed: [total]
- Weekly quota consumed: [pct]
- Estimated weekly tokens: [number]

See JSON file for full detail."
```

Fill in `[total]`, `[pct]`, `[number]` from the actual JSON.

## If `gh` isn't configured

If the user doesn't have `gh` auth set up, don't force it. Fallback path:

1. Show the contents of the generated JSON file to the user
2. Tell them: "Open <https://github.com/desktop-commander/best-value-ai/issues/new> and paste this JSON as a new issue titled `[measurement] <plan> / <model>`. A maintainer will add it."
3. Do NOT attempt to bypass auth by making unauthenticated git operations — they will fail silently or produce orphan commits.

## Common issues

### "tmux: couldn't open a new pty"

User is over their system's pty limit. `tmux kill-server` may clean up. On macOS, may need to restart terminal.

### Script hangs forever

The TUI didn't respond to keystrokes. Kill the tmux session, check if the CLI is actually logged in (`claude auth status` / `codex auth status`), retry. Some versions of the TUI change keybindings — if the script is outdated, log an issue in the repo.

### Quota numbers look wrong

If `quota_after == quota_before`, the script measured zero consumption — the TUI's `/status` output parsing probably failed. The JSON will still be written but the `quota_consumed` field will be misleading. Don't submit this measurement.

### Codex CLI version mismatch

The script pins nothing — it uses whatever `npx codex` resolves to. Include the version from `codex --version` in the PR description so reviewers know what was tested.

## What NOT to do

- Don't edit the JSON after the script writes it. The value is in the raw captured data — editing defeats the empirical point.
- Don't measure with a plan you don't actually have (or using someone else's account). Measurements get attributed to the plan name.
- Don't run the script in parallel with heavy CLI usage on the same plan — it'll skew the quota readings.
- Don't guess at missing fields. If `model` came back empty, investigate, don't fill in a plausible value.

## About this skill

- Repo: [desktop-commander/best-value-ai](https://github.com/desktop-commander/best-value-ai)
- Methodology: see [MEASUREMENT_METHODOLOGY.md](../../MEASUREMENT_METHODOLOGY.md) and [CONTRIBUTING.md](../../CONTRIBUTING.md)
- Scripts: [measure-claude-quota.sh](../../scripts/measure-claude-quota.sh), [measure-codex-quota.sh](../../scripts/measure-codex-quota.sh)
- License: Apache 2.0
- Issues or script fixes: open a PR or issue in the repo
