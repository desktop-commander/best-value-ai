#!/usr/bin/env bash
# Fully automated Claude Code subscription quota measurement
# Streams all progress to stdout. Final JSON result printed at end.
# Usage: bash scripts/measure-claude-quota.sh [working_directory]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$REPO_DIR/measurements"
mkdir -p "$RESULTS_DIR"
TS=$(date +%Y%m%d_%H%M%S)
RESULT_FILE="$RESULTS_DIR/claude_measurement_${TS}.json"
WORK_DIR="${1:-$REPO_DIR}"
SN="claude_m_$$"

echo "=== Claude Code Quota Measurement · $TS ==="
echo "Work dir: $WORK_DIR"

# Preflight
command -v tmux &>/dev/null || { echo "FAIL: tmux not found"; exit 1; }
command -v claude &>/dev/null || { echo "FAIL: claude not found"; exit 1; }
VER=$(claude --version 2>/dev/null || echo "unknown")
echo "Claude Code: $VER"

# ── Function: capture /status Usage tab via tmux ──
capture_status() {
    local label="$1" outfile="$2"
    echo ""
    echo "--- $label: launching tmux ---"
    tmux kill-session -t "$SN" 2>/dev/null || true
    tmux new-session -d -s "$SN" -x 120 -y 50 "cd '$WORK_DIR' && claude"

    echo "$label: waiting 10s for TUI..."
    sleep 10

    # Check for trust dialog
    local screen=$(tmux capture-pane -t "$SN" -p)
    if echo "$screen" | grep -q "trust the files"; then
        echo "$label: accepting trust dialog..."
        tmux send-keys -t "$SN" Enter
        sleep 5
    fi

    echo "$label: sending Escape..."
    tmux send-keys -t "$SN" Escape
    sleep 1

    echo "$label: sending /status Enter..."
    tmux send-keys -t "$SN" '/status'
    sleep 0.5
    tmux send-keys -t "$SN" Enter

    echo "$label: waiting 4s for status popup..."
    sleep 4

    echo "$label: Tab Tab to Usage tab..."
    tmux send-keys -t "$SN" Tab
    sleep 1
    tmux send-keys -t "$SN" Tab

    echo "$label: waiting 3s for Usage to render..."
    sleep 3

    echo "$label: capturing screen..."
    tmux capture-pane -t "$SN" -p > "$outfile"

    # Verify we got usage data
    if grep -q "% used" "$outfile" 2>/dev/null; then
        echo "$label: ✓ captured successfully"
        grep "% used" "$outfile"
    else
        echo "$label: ⚠ no '% used' found, retrying..."
        tmux send-keys -t "$SN" Escape
        sleep 2
        tmux send-keys -t "$SN" '/status'
        sleep 0.5
        tmux send-keys -t "$SN" Enter
        sleep 4
        tmux send-keys -t "$SN" Tab
        sleep 1
        tmux send-keys -t "$SN" Tab
        sleep 5
        tmux capture-pane -t "$SN" -p > "$outfile"
        if grep -q "% used" "$outfile" 2>/dev/null; then
            echo "$label: ✓ retry succeeded"
            grep "% used" "$outfile"
        else
            echo "$label: ✗ FAILED. Screen content:"
            head -25 "$outfile"
        fi
    fi

    echo "$label: killing tmux..."
    tmux kill-session -t "$SN" 2>/dev/null || true
}

# ── Function: parse Claude usage from captured screen ──
parse_status() {
    python3 -c "
import re, json
text = open('$1').read()
d = {}
m = re.search(r'Current session.*?(\d+)%\s*used', text, re.DOTALL)
if m: d['session_pct_used'] = int(m.group(1))
m = re.search(r'Current week \(all models\).*?(\d+)%\s*used', text, re.DOTALL)
if m: d['weekly_all_pct_used'] = int(m.group(1))
m = re.search(r'Current week \(Sonnet only\).*?(\d+)%\s*used', text, re.DOTALL)
if m: d['weekly_sonnet_pct_used'] = int(m.group(1))
# Try to get plan from the welcome screen or status
m = re.search(r'(Sonnet|Opus)\s+[\d.]+\s*·\s*(Claude (?:Pro|Max))', text)
if m: d['model'] = m.group(0).split('·')[0].strip(); d['plan'] = m.group(2)
print(json.dumps(d))
"
}

# ═══════════════════════════════════════
# STEP 1: BEFORE
# ═══════════════════════════════════════
BF="/tmp/claude_bf_${TS}.txt"
capture_status "BEFORE" "$BF"
BEFORE_JSON=$(parse_status "$BF")
echo ""
echo "BEFORE=$BEFORE_JSON"

# ═══════════════════════════════════════
# STEP 2: RUN TASKS
# ═══════════════════════════════════════
echo ""
echo "--- TASK: running iterations ---"
PROMPT="Write a Python doubly-linked list with insert_head, insert_tail, delete_node, find, reverse, to_list. Include Node class, type hints, docstrings. Write exactly 10 pytest tests. Output only the code."
TOTAL_IN=0; TOTAL_CACHED=0; TOTAL_OUT=0; TOTAL_DUR=0; RUNS=0
NUM_RUNS=${NUM_RUNS:-5}

cd "$WORK_DIR"
for i in $(seq 1 $NUM_RUNS); do
    JF="/tmp/claude_run_${TS}_${i}.json"
    echo "  Run $i/$NUM_RUNS..."
    T0=$(date +%s)
    echo "" | claude -p "$PROMPT" --output-format json > "$JF" 2>/dev/null || true
    T1=$(date +%s)
    DUR=$((T1 - T0))
    TOTAL_DUR=$((TOTAL_DUR + DUR))
    RUNS=$((RUNS + 1))

    # Parse tokens from Claude JSON output
    TOKS=$(python3 -c "
import json, sys
try:
    data = json.load(open('$JF'))
    usage = data.get('usage', {})
    if not usage and 'result' in data:
        usage = data.get('result', {}).get('usage', {})
    inp = usage.get('input_tokens', 0)
    out = usage.get('output_tokens', 0)
    cache_read = usage.get('cache_read_input_tokens', 0)
    cache_create = usage.get('cache_creation_input_tokens', 0)
    # Total input = input_tokens + cache_read + cache_create
    total_input = inp + cache_read + cache_create
    cached = cache_read + cache_create
    print(total_input, cached, out)
except Exception as e:
    print('0 0 0')
    sys.stderr.write(f'Parse error: {e}\n')
" 2>&1)
    read ri rc ro <<< "$TOKS"
    TOTAL_IN=$((TOTAL_IN + ri))
    TOTAL_CACHED=$((TOTAL_CACHED + rc))
    TOTAL_OUT=$((TOTAL_OUT + ro))
    echo "    ${DUR}s · in=$ri cached=$rc out=$ro · cumulative=$((TOTAL_IN+TOTAL_OUT))"
done
TOTAL=$((TOTAL_IN + TOTAL_OUT))
echo ""
echo "TASK TOTALS: $RUNS runs · ${TOTAL} tokens (in=$TOTAL_IN cached=$TOTAL_CACHED out=$TOTAL_OUT) · ${TOTAL_DUR}s"

# ═══════════════════════════════════════
# STEP 3: AFTER
# ═══════════════════════════════════════
AF="/tmp/claude_af_${TS}.txt"
capture_status "AFTER" "$AF"
AFTER_JSON=$(parse_status "$AF")
echo ""
echo "AFTER=$AFTER_JSON"

# ═══════════════════════════════════════
# STEP 4: CALCULATE + OUTPUT JSON
# ═══════════════════════════════════════
echo ""
echo "--- CALCULATING ---"
python3 << PYEOF
import json
from datetime import datetime, timezone

before = json.loads('$BEFORE_JSON')
after = json.loads('$AFTER_JSON')
total = $TOTAL

est = {}

# Claude shows "% used" (not "% left" like Codex)
bs = before.get('session_pct_used')
as_ = after.get('session_pct_used')
bw = before.get('weekly_all_pct_used')
aw = after.get('weekly_all_pct_used')

if bs is not None and as_ is not None:
    ds = as_ - bs
    print(f'Session delta: {bs}% -> {as_}% = {ds}% consumed')
    if ds > 0 and total > 0:
        e = int(total / (ds/100))
        est['session_tokens'] = e
        print(f'Session estimate: {e:,} ({e/1e6:.1f}M)')
    else:
        print(f'Session delta = {ds}%, cannot estimate')
else:
    ds = None
    print('Session: missing data')

if bw is not None and aw is not None:
    dw = aw - bw
    print(f'Weekly delta: {bw}% -> {aw}% = {dw}% consumed')
    if dw > 0 and total > 0:
        e = int(total / (dw/100))
        daily = e // 7
        est['weekly_tokens'] = e
        est['daily_tokens'] = daily
        print(f'Weekly estimate: {e:,} ({e/1e6:.1f}M), daily: {daily:,} ({daily/1e6:.1f}M)')
    else:
        print(f'Weekly delta = {dw}%, cannot estimate')
else:
    dw = None
    print('Weekly: missing data')

result = {
    'tool': 'claude-code', 'version': '$VER',
    'plan': after.get('plan', before.get('plan', 'unknown')),
    'model': after.get('model', before.get('model', 'unknown')),
    'timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'task': 'doubly-linked-list-with-tests',
    'num_runs': $RUNS, 'duration_seconds': $TOTAL_DUR,
    'tokens': {'input': $TOTAL_IN, 'cached': $TOTAL_CACHED, 'output': $TOTAL_OUT, 'total': $TOTAL},
    'quota_before': before, 'quota_after': after,
    'quota_consumed': {'session_pct': ds, 'weekly_all_pct': dw},
    'estimates': est,
}

with open('$RESULT_FILE', 'w') as f:
    json.dump(result, f, indent=2)
print()
print(f'Saved: $RESULT_FILE')
print()
print('=== RESULT JSON ===')
print(json.dumps(result, indent=2))
PYEOF
