#!/usr/bin/env bash
# Fully automated Codex CLI subscription quota measurement
# Usage: bash scripts/measure-codex-quota.sh [working_directory]
#
# Requires: tmux, npx codex (logged in)
#
# This script:
# 1. Launches Codex TUI in tmux, reads /status → BEFORE percentages
# 2. Runs a standardized task via codex exec --json → exact token counts
# 3. Re-launches TUI, reads /status → AFTER percentages
# 4. Calculates quota estimates
# 5. Saves timestamped JSON

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$REPO_DIR/measurements"
mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULT_FILE="$RESULTS_DIR/codex_measurement_${TIMESTAMP}.json"
WORK_DIR="${1:-$(mktemp -d)}"
SESSION_NAME="codex_measure_$$"
CODEX="npx codex"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  LLM Value Comparison — Codex Quota Measurement (automated) ║"
echo "║  https://desktop-commander.github.io/llm-value-comparison   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Timestamp: $TIMESTAMP"
echo "  Work dir:  $WORK_DIR"
echo ""

# ── Preflight checks ──
command -v tmux &>/dev/null || { echo "✗ tmux not found. Install: brew install tmux"; exit 1; }
$CODEX --version &>/dev/null 2>&1 || { echo "✗ Codex CLI not found. Install: npm install -g @openai/codex"; exit 1; }
VERSION=$($CODEX --version 2>/dev/null || echo "unknown")
echo "✓ Codex CLI $VERSION"
echo "✓ tmux available"
echo ""

# Ensure work dir is a git repo (codex requires it)
if [ ! -d "$WORK_DIR/.git" ]; then
    mkdir -p "$WORK_DIR"
    cd "$WORK_DIR" && git init -q
    echo "✓ Initialized git repo in $WORK_DIR"
fi


# ── Helper: get Codex /status via tmux ──
get_codex_status() {
    local label="$1"
    local outfile="$2"

    echo "  [$label] Launching Codex TUI in tmux..."
    tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
    tmux new-session -d -s "$SESSION_NAME" -x 120 -y 50 "cd '$WORK_DIR' && $CODEX"
    
    echo "  [$label] Waiting 18s for TUI + MCP init..."
    sleep 18

    # Dismiss any welcome/tip screen first
    tmux send-keys -t "$SESSION_NAME" Escape
    sleep 2

    # Send Escape again to ensure clean state, then /status + Enter
    echo "  [$label] Sending /status..."
    tmux send-keys -t "$SESSION_NAME" Escape
    sleep 1
    tmux send-keys -t "$SESSION_NAME" '/status'
    sleep 1
    tmux send-keys -t "$SESSION_NAME" Enter

    echo "  [$label] Waiting 12s for rate limit fetch..."
    sleep 12

    # Capture screen
    tmux capture-pane -t "$SESSION_NAME" -p > "$outfile"
    echo "  [$label] Screen captured"

    # Kill session
    tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
    echo "  [$label] Session closed"
}

# ── Helper: parse Codex /status output ──
parse_codex_status() {
    local file="$1"
    python3 -c "
import re, json
text = open('$file').read()
data = {}
# Codex shows: '5h limit: [████░░] 88% left (resets 22:14)'
m = re.search(r'5h limit:.*?(\d+)%\s*left', text)
if m: data['5h_pct_left'] = int(m.group(1))
m = re.search(r'Weekly limit:.*?(\d+)%\s*left', text)
if m: data['weekly_pct_left'] = int(m.group(1))
m = re.search(r'Account:\s*(.*?)(?:\n|│)', text)
if m: data['account'] = m.group(1).strip()
m = re.search(r'Model:\s*(.*?)(?:\n|│)', text)
if m: data['model'] = m.group(1).strip()
print(json.dumps(data))
"
}


# ── Step 1: Capture BEFORE ──
echo "═══ Step 1: Capturing current usage (BEFORE) ═══"
BEFORE_FILE="/tmp/codex_before_${TIMESTAMP}.txt"
get_codex_status "BEFORE" "$BEFORE_FILE"

BEFORE_JSON=$(parse_codex_status "$BEFORE_FILE")
echo "  BEFORE: $BEFORE_JSON"
echo ""

# ── Step 2: Run standardized task ──
echo "═══ Step 2: Running standardized coding task ═══"
TASK_PROMPT="Write a Python doubly-linked list with insert_head, insert_tail, delete_node, find, reverse, to_list methods. Include Node class, type hints, docstrings. Write exactly 10 pytest tests. Save to linked_list.py"
TASK_JSONL="/tmp/codex_task_${TIMESTAMP}.jsonl"

echo "  Task: Doubly-linked list + 10 tests"
TASK_START=$(date +%s)

cd "$WORK_DIR"
echo "$TASK_PROMPT" | $CODEX exec --json - > "$TASK_JSONL" 2>/tmp/codex_task_stderr_${TIMESTAMP}.log || true

TASK_END=$(date +%s)
TASK_DURATION=$((TASK_END - TASK_START))
echo "  Completed in ${TASK_DURATION}s"

# Parse token counts from JSONL
TASK_TOKENS=$(python3 -c "
import json
total_input = total_cached = total_output = 0
for line in open('$TASK_JSONL'):
    try:
        d = json.loads(line.strip())
        if d.get('type') == 'turn.completed':
            u = d.get('usage', {})
            total_input += u.get('input_tokens', 0)
            total_cached += u.get('cached_input_tokens', 0)
            total_output += u.get('output_tokens', 0)
    except: pass
total = total_input + total_output
print(json.dumps({'input': total_input, 'cached': total_cached, 'output': total_output, 'total': total}))
")
echo "  Tokens: $TASK_TOKENS"
echo ""


# ── Step 3: Capture AFTER ──
echo "═══ Step 3: Capturing usage (AFTER) ═══"
AFTER_FILE="/tmp/codex_after_${TIMESTAMP}.txt"
get_codex_status "AFTER" "$AFTER_FILE"

AFTER_JSON=$(parse_codex_status "$AFTER_FILE")
echo "  AFTER: $AFTER_JSON"
echo ""

# ── Step 4: Calculate and save ──
echo "═══ Step 4: Calculating quota estimates ═══"

python3 << PYEOF
import json
from datetime import datetime, timezone

before = json.loads('$BEFORE_JSON')
after = json.loads('$AFTER_JSON')
tokens = json.loads('$TASK_TOKENS')

# Calculate deltas (Codex shows % LEFT, so consumed = before - after)
# If BEFORE is empty (first run), assume 100% left
delta_5h = before.get('5h_pct_left', 100) - after.get('5h_pct_left', 100)
delta_weekly = before.get('weekly_pct_left', 100) - after.get('weekly_pct_left', 100)
before_note = ''
if not before.get('5h_pct_left'):
    before_note = ' (BEFORE capture failed — assuming 100% as baseline)'
    print(f'  ⚠ BEFORE status was empty, assuming fresh window (100%/100%)')
    before['5h_pct_left'] = 100
    before['weekly_pct_left'] = 100
    delta_5h = 100 - after.get('5h_pct_left', 100)
    delta_weekly = 100 - after.get('weekly_pct_left', 100)
total = tokens.get('total', 0)

estimates = {}
if delta_5h > 0 and total > 0:
    est = int(total / (delta_5h / 100))
    daily_from_5h = est * (24/5)
    estimates['5h_window_tokens'] = est
    estimates['5h_readable'] = f"~{est/1e6:.1f}M tokens per 5h window"
    print(f"  5h: {delta_5h}% consumed -> ~{est/1e6:.1f}M per window (~{daily_from_5h/1e6:.1f}M/day if not weekly-limited)")
else:
    print(f"  5h: {delta_5h}% change (not enough for estimate)")

if delta_weekly > 0 and total > 0:
    est = int(total / (delta_weekly / 100))
    daily = est // 7
    estimates['weekly_tokens'] = est
    estimates['daily_tokens'] = daily
    estimates['weekly_readable'] = f"~{est/1e6:.1f}M tokens per week"
    estimates['daily_readable'] = f"~{daily/1e6:.1f}M tokens per day"
    print(f"  Weekly: {delta_weekly}% consumed -> ~{est/1e6:.1f}M/week, ~{daily/1e6:.1f}M/day")
else:
    print(f"  Weekly: {delta_weekly}% change (not enough for estimate)")

# Determine binding constraint
if estimates.get('daily_tokens') and estimates.get('5h_window_tokens'):
    daily_5h = int(estimates['5h_window_tokens'] * 24 / 5)
    daily_weekly = estimates['daily_tokens']
    estimates['binding_constraint'] = 'weekly' if daily_weekly < daily_5h else '5h'
    estimates['effective_daily'] = min(daily_5h, daily_weekly)
    print(f"  Binding constraint: {estimates['binding_constraint']}")
    print(f"  Effective daily: ~{estimates['effective_daily']/1e6:.1f}M tokens/day")

result = {
    "tool": "codex-cli",
    "version": "$VERSION",
    "plan": after.get('account', before.get('account', 'unknown')),
    "model": after.get('model', before.get('model', 'unknown')),
    "timestamp": datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    "task": "doubly-linked-list-with-tests",
    "task_duration_seconds": $TASK_DURATION,
    "tokens": tokens,
    "quota_before": before,
    "quota_after": after,
    "quota_consumed": {"5h_pct": delta_5h, "weekly_pct": delta_weekly},
    "estimates": estimates,
    "raw_files": {
        "before_screen": "$BEFORE_FILE",
        "after_screen": "$AFTER_FILE",
        "task_jsonl": "$TASK_JSONL"
    }
}

with open('$RESULT_FILE', 'w') as f:
    json.dump(result, f, indent=2)

print(f"\n  ✓ Saved: $RESULT_FILE")
PYEOF

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Measurement complete!                                      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Result: $RESULT_FILE"
echo ""
echo "  Submit: https://github.com/desktop-commander/llm-value-comparison/issues/new"
echo ""
