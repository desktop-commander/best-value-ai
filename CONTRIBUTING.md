# Contributing to LLM Value Comparison

This project needs community data to stay accurate. There are several ways to contribute:

## 1. Measure your subscription's token quota

The most valuable contribution. Providers don't publish exact token limits — we measure them empirically.

### For Codex CLI (ChatGPT Plus/Pro)

**Prerequisites:** Codex CLI installed, logged in with your ChatGPT subscription, tmux installed.

**Quick start:**
```bash
git clone https://github.com/desktop-commander/llm-value-comparison.git
cd llm-value-comparison
bash scripts/measure-codex-quota.sh
```

**How it works:**
1. Records your current quota (% left) via `/status` in the Codex TUI
2. Runs a standardized coding task with `--json` to get exact token counts
3. Records quota again after the task
4. Calculates: `total_quota = tokens_consumed / (pct_consumed / 100)`


**Manual measurement if the script doesn't work:**
```bash
# Step 1: Open Codex TUI, run /status, note the percentages
npx codex
# In the TUI: /status → note "5h limit: X% left" and "Weekly: Y% left"
# Exit with /exit

# Step 2: Run a standardized task
cd /tmp && mkdir measurement && cd measurement && git init
echo "Write a Python doubly-linked list with insert_head, insert_tail, delete_node, find, reverse, to_list methods. Include Node class, type hints, docstrings. Write exactly 10 pytest tests." | npx codex exec --json - > task_output.jsonl

# Step 3: Get token counts from the JSONL
grep "turn.completed" task_output.jsonl
# Look for: {"type":"turn.completed","usage":{"input_tokens":X,"cached_input_tokens":Y,"output_tokens":Z}}

# Step 4: Run /status again in the TUI, note new percentages

# Step 5: Calculate
# tokens_consumed = input_tokens + output_tokens (from step 3)
# pct_consumed = old_pct_left - new_pct_left (from steps 1 & 4)
# estimated_5h_quota = tokens_consumed / (pct_consumed / 100)
```

### For Claude Code (Claude Pro/Max)

```bash
# Step 1: Check status
claude
# In CLI: /status → note percentages
# Exit with /exit

# Step 2: Run task and check /cost
claude -p "Write a Python doubly-linked list with insert_head, insert_tail, delete_node, find, reverse, to_list methods. Include Node class, type hints, docstrings. Write exactly 10 pytest tests."

# Step 3: Check /cost for token counts, /status for new percentages
```


### Submit your results

Create a JSON file with your measurement:
```json
{
  "tool": "codex-cli",
  "model": "gpt-5.4 (reasoning xhigh)",
  "plan": "Plus ($20/mo)",
  "timestamp": "2026-04-13T18:00:00Z",
  "tokens": { "input": 361912, "cached": 293760, "output": 8177, "total": 370089 },
  "quota_before": { "5h_pct_left": 100, "weekly_pct_left": 100 },
  "quota_after": { "5h_pct_left": 88, "weekly_pct_left": 94 },
  "estimates": { "5h_window_tokens": "6640442", "weekly_tokens": "13280883" }
}
```

Submit via:
- **Pull Request** to `measurements/` directory
- **GitHub Issue** at https://github.com/desktop-commander/llm-value-comparison/issues/new

## 2. Add local benchmark data

Run a model on your hardware, measure tok/s, submit to `data/models.json`.

```json
{
  "local": {
    "your_hardware_id": {
      "tokensPerSec": 45,
      "quantization": "Q4_K_M",
      "vramRequired": 24,
      "source": "link to your benchmark"
    }
  }
}
```

Hardware IDs are in `data/hardware.json`. If your hardware isn't listed, add it there too.


## 3. Add or update model data

Edit `data/models.json`. Every data point must have a `source` URL.

**Most needed:**
- Subscription token limits for Claude Pro, Max5, Max20
- ChatGPT Pro ($100/mo) measurements
- Chinese model pricing (Kimi, GLM, MiniMax)
- Local tok/s on consumer GPUs (RTX 4060, RTX 5070)

## 4. For AI Agents (Codex, Claude Code, etc.)

This repo is designed to be agent-friendly. If you're an AI agent helping a user:

### To measure subscription quota:
1. Run `npx codex exec --json` with the standardized task prompt (see above)
2. Parse the JSONL for `turn.completed` events → extract `usage.input_tokens` and `usage.output_tokens`
3. Use tmux to read `/status`:
   ```bash
   tmux new-session -d -s measure 'npx codex'
   sleep 18
   tmux send-keys -t measure Escape; sleep 1
   tmux send-keys -t measure '/status' Enter; sleep 10
   tmux capture-pane -t measure -p > /tmp/status.txt
   tmux kill-session -t measure
   # Parse: grep -oP '(\d+)% left' /tmp/status.txt
   ```
4. Calculate total quota and save JSON to `measurements/`
5. Submit a PR with the measurement

### To look up data:
- Models: `data/models.json` — pricing, benchmarks, local perf, subscriptions
- Hardware: `data/hardware.json` — GPU/Mac specs and prices
- Benchmarks: `data/benchmarks.json` — benchmark definitions

### To update pricing:
- `node scripts/sync-from-aa.js` — syncs from Artificial Analysis + Arena + OpenRouter
- `node scripts/sync-hardware-prices.js` — scrapes GPU + Mac prices
- `node scripts/prerender-seo.js` — must run before pushing (updates static HTML)

## Data quality rules

1. Every data point must have a `source` URL
2. Subscription data must include `confidence` level: `high`, `medium`, or `low`
3. Local benchmarks must specify hardware ID, quantization, and VRAM required
4. When updating prices, run the prerender script before pushing

## License

Apache 2.0 — see [NOTICE](NOTICE). Any public deployment must credit Desktop Commander.
