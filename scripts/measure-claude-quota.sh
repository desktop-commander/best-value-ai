#!/usr/bin/env bash
# Fully automated Claude Code subscription quota measurement
# Usage: bash scripts/measure-claude-quota.sh [working_directory]
#
# This script:
# 1. Launches Claude Code TUI in tmux
# 2. Navigates to /status → Usage tab, captures BEFORE percentages
# 3. Exits the TUI, runs a standardized task via claude -p --output-format json
# 4. Re-launches TUI, captures AFTER percentages
# 5. Calculates quota estimates
# 6. Saves everything to a timestamped JSON file

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$REPO_DIR/measurements"
mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULT_FILE="$RESULTS_DIR/claude_measurement_${TIMESTAMP}.json"
WORK_DIR="${1:-$REPO_DIR}"
SESSION_NAME="claude_measure_$$"


echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  LLM Value Comparison — Claude Code Quota Measurement       ║"
echo "║  https://desktop-commander.github.io/llm-value-comparison   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Working directory: $WORK_DIR"
echo "  Timestamp:         $TIMESTAMP"
echo ""

# ── Helper: get Claude /status Usage tab via tmux ──
get_claude_usage() {
    local label="$1"
    local outfile="$2"

    echo "  [$label] Launching Claude Code TUI in tmux..."
    tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
    tmux new-session -d -s "$SESSION_NAME" -x 120 -y 50 "cd '$WORK_DIR' && claude"
    sleep 8

    # Accept trust dialog if it appears
    local screen=$(tmux capture-pane -t "$SESSION_NAME" -p)
    if echo "$screen" | grep -q "trust the files"; then
        echo "  [$label] Accepting trust dialog..."
        tmux send-keys -t "$SESSION_NAME" Enter
        sleep 5
    fi

    # Open /status
    echo "  [$label] Opening /status..."
    tmux send-keys -t "$SESSION_NAME" Escape
    sleep 0.5
    tmux send-keys -t "$SESSION_NAME" '/status'
    sleep 0.5
    tmux send-keys -t "$SESSION_NAME" Enter
    sleep 4

    # Navigate to Usage tab (Status → Config → Usage = 2 tabs)
    echo "  [$label] Navigating to Usage tab..."
    tmux send-keys -t "$SESSION_NAME" Tab
    sleep 1
    tmux send-keys -t "$SESSION_NAME" Tab
    sleep 3

    # Capture screen
    tmux capture-pane -t "$SESSION_NAME" -p > "$outfile"
    
    # Verify we got usage data
    if ! grep -q "% used" "$outfile" 2>/dev/null; then
        echo "  [$label] ⚠ First capture missed Usage tab, retrying..."
        tmux send-keys -t "$SESSION_NAME" Escape
        sleep 2
        tmux send-keys -t "$SESSION_NAME" '/status'
        sleep 0.5
        tmux send-keys -t "$SESSION_NAME" Enter
        sleep 4
        tmux send-keys -t "$SESSION_NAME" Tab
        sleep 1
        tmux send-keys -t "$SESSION_NAME" Tab
        sleep 5
        tmux capture-pane -t "$SESSION_NAME" -p > "$outfile"
        
        if ! grep -q "% used" "$outfile" 2>/dev/null; then
            echo "  [$label] ✗ FAILED to capture Usage after 2 attempts"
            head -20 "$outfile"
        fi
    fi
    
    echo "  [$label] Screen captured to $outfile"

    # Close session
    tmux send-keys -t "$SESSION_NAME" Escape
    sleep 1
    tmux send-keys -t "$SESSION_NAME" '/exit'
    sleep 0.5
    tmux send-keys -t "$SESSION_NAME" Enter
    sleep 2
    tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
}


# ── Helper: parse usage percentages from captured screen ──
parse_usage() {
    local file="$1"
    python3 -c "
import re, json, sys
text = open('$file').read()
data = {}
m = re.search(r'Current session.*?(\d+)%\s*used', text, re.DOTALL)
if m: data['session_pct_used'] = int(m.group(1))
m = re.search(r'Current week \(all models\).*?(\d+)%\s*used', text, re.DOTALL)
if m: data['weekly_all_pct_used'] = int(m.group(1))
m = re.search(r'Current week \(Sonnet only\).*?(\d+)%\s*used', text, re.DOTALL)
if m: data['weekly_sonnet_pct_used'] = int(m.group(1))
m = re.search(r'(Sonnet|Opus)\s+[\d.]+\s*·\s*(Claude (?:Pro|Max))', text)
if m: data['model'] = m.group(1) + ' ' + m.group(0).split('·')[0].strip(); data['plan'] = m.group(2)
print(json.dumps(data))
"
}

# ── Step 1: Capture BEFORE usage ──
echo "═══ Step 1: Capturing current usage (BEFORE) ═══"
BEFORE_FILE="/tmp/claude_before_${TIMESTAMP}.txt"
get_claude_usage "BEFORE" "$BEFORE_FILE"

BEFORE_JSON=$(parse_usage "$BEFORE_FILE")
echo "  BEFORE: $BEFORE_JSON"
echo ""


# ── Step 2: Run standardized task ──
echo "═══ Step 2: Running standardized coding task ═══"
TASK_PROMPT="Write a Python doubly-linked list with insert_head, insert_tail, delete_node, find, reverse, to_list methods. Include Node class, type hints, docstrings. Write exactly 10 pytest tests. Output only the code."
TASK_OUTPUT="/tmp/claude_task_${TIMESTAMP}.json"

echo "  Task: Doubly-linked list + 10 tests"
echo "  Running via: claude -p --output-format json"
TASK_START=$(date +%s)

cd "$WORK_DIR"
claude -p "$TASK_PROMPT" --output-format json > "$TASK_OUTPUT" 2>/tmp/claude_task_stderr_${TIMESTAMP}.log

TASK_END=$(date +%s)
TASK_DURATION=$((TASK_END - TASK_START))
echo "  Task completed in ${TASK_DURATION}s"

# Parse token counts from JSON output
TASK_TOKENS=$(python3 -c "
import json, sys
try:
    data = json.load(open('$TASK_OUTPUT'))
    usage = data.get('usage', data.get('result', {}).get('usage', {}))
    inp = usage.get('input_tokens', 0)
    out = usage.get('output_tokens', 0)
    cache_read = usage.get('cache_read_input_tokens', usage.get('cache_creation_input_tokens', 0))
    cache_create = usage.get('cache_creation_input_tokens', 0)
    total = inp + out
    print(json.dumps({
        'input_tokens': inp,
        'output_tokens': out,
        'cache_read': cache_read,
        'cache_create': cache_create,
        'total': total
    }))
except Exception as e:
    # Try to find usage in the raw output
    text = open('$TASK_OUTPUT').read()
    print(json.dumps({'raw_length': len(text), 'error': str(e)}))
")
echo "  Tokens: $TASK_TOKENS"
echo ""


# ── Step 3: Capture AFTER usage ──
echo "═══ Step 3: Capturing usage (AFTER) ═══"
AFTER_FILE="/tmp/claude_after_${TIMESTAMP}.txt"
get_claude_usage "AFTER" "$AFTER_FILE"

AFTER_JSON=$(parse_usage "$AFTER_FILE")
echo "  AFTER: $AFTER_JSON"
echo ""

# ── Step 4: Calculate and save ──
echo "═══ Step 4: Calculating quota estimates ═══"

python3 << PYEOF
import json, sys
from datetime import datetime, timezone

before = json.loads('$BEFORE_JSON')
after = json.loads('$AFTER_JSON')
tokens = json.loads('$TASK_TOKENS')

# Calculate deltas
session_delta = (after.get('session_pct_used', 0) - before.get('session_pct_used', 0))
weekly_delta = (after.get('weekly_all_pct_used', 0) - before.get('weekly_all_pct_used', 0))
sonnet_delta = (after.get('weekly_sonnet_pct_used', 0) - before.get('weekly_sonnet_pct_used', 0))

total_tokens = tokens.get('total', 0)

estimates = {}
if session_delta > 0 and total_tokens > 0:
    est = int(total_tokens / (session_delta / 100))
    estimates['session_total_tokens'] = est
    estimates['session_readable'] = f"~{est/1e6:.1f}M tokens per session window"
    print(f"  Session: {session_delta}% consumed → ~{est/1e6:.1f}M tokens per session")
else:
    print(f"  Session: {session_delta}% change (insufficient for estimate)")

if weekly_delta > 0 and total_tokens > 0:
    est = int(total_tokens / (weekly_delta / 100))
    daily = est // 7
    estimates['weekly_total_tokens'] = est
    estimates['daily_tokens'] = daily
    estimates['weekly_readable'] = f"~{est/1e6:.1f}M tokens per week"
    estimates['daily_readable'] = f"~{daily/1e6:.1f}M tokens per day"
    print(f"  Weekly:  {weekly_delta}% consumed → ~{est/1e6:.1f}M/week, ~{daily/1e6:.1f}M/day")
else:
    print(f"  Weekly:  {weekly_delta}% change (insufficient for estimate)")

# Build final result
result = {
    "tool": "claude-code",
    "version": "2.0.36",
    "plan": after.get('plan', before.get('plan', 'unknown')),
    "model": after.get('model', before.get('model', 'unknown')),
    "timestamp": datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    "task": "doubly-linked-list-with-tests",
    "task_duration_seconds": $TASK_DURATION,
    "tokens": tokens,
    "quota_before": before,
    "quota_after": after,
    "quota_consumed": {
        "session_pct": session_delta,
        "weekly_all_pct": weekly_delta,
        "weekly_sonnet_pct": sonnet_delta
    },
    "estimates": estimates,
    "raw_files": {
        "before_screen": "$BEFORE_FILE",
        "after_screen": "$AFTER_FILE",
        "task_output": "$TASK_OUTPUT"
    }
}

with open('$RESULT_FILE', 'w') as f:
    json.dump(result, f, indent=2)

print(f"\n  ✓ Results saved to: $RESULT_FILE")
PYEOF

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Measurement complete!                                      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Result: $RESULT_FILE"
echo ""
echo "  Submit via PR or issue:"
echo "  https://github.com/desktop-commander/llm-value-comparison/issues/new"
echo ""
