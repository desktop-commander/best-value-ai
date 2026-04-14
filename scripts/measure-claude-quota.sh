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
echo "--- TASK: running parallel batches until quota moves ---"
echo "Claude tasks use ~17K tokens each. Running in parallel to move the needle faster."
PROMPT="Write a Python doubly-linked list with insert_head, insert_tail, delete_node, find, reverse, to_list. Include Node class, type hints, docstrings. Write exactly 10 pytest tests. Output only the code."
TOTAL_IN=0; TOTAL_CACHED=0; TOTAL_OUT=0; TOTAL_DUR=0; RUNS=0
MAX_BATCHES=${MAX_BATCHES:-20}
PARALLEL=${PARALLEL:-10}
MIN_PCT_CHANGE=${MIN_PCT_CHANGE:-1}

# Get BEFORE weekly % to compare against
BEFORE_WEEKLY=$(echo "$BEFORE_JSON" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('weekly_all_pct_used', -1))")
echo "Target: detect ≥${MIN_PCT_CHANGE}% weekly change from ${BEFORE_WEEKLY}%"
echo "Parallel: $PARALLEL tasks per batch, max $MAX_BATCHES batches"
echo ""

cd "$WORK_DIR"
for batch in $(seq 1 $MAX_BATCHES); do
    echo "  Batch $batch/$MAX_BATCHES ($PARALLEL parallel tasks)..."
    T0=$(date +%s)

    # Launch PARALLEL tasks in background
    PIDS=""
    for j in $(seq 1 $PARALLEL); do
        RUN_NUM=$(( (batch-1)*PARALLEL + j ))
        JF="/tmp/claude_run_${TS}_${RUN_NUM}.json"
        (echo "" | claude -p "$PROMPT" --output-format json > "$JF" 2>/dev/null) &
        PIDS="$PIDS $!"
    done

    # Wait for all to finish
    for pid in $PIDS; do
        wait $pid 2>/dev/null || true
    done

    T1=$(date +%s)
    DUR=$((T1 - T0))
    TOTAL_DUR=$((TOTAL_DUR + DUR))

    # Parse tokens from all runs in this batch
    BATCH_TOTAL=0
    for j in $(seq 1 $PARALLEL); do
        RUN_NUM=$(( (batch-1)*PARALLEL + j ))
        JF="/tmp/claude_run_${TS}_${RUN_NUM}.json"
        TOKS=$(python3 -c "
import json
try:
    d=json.load(open('$JF'))
    u=d.get('usage',{})
    inp=u.get('input_tokens',0)+u.get('cache_creation_input_tokens',0)+u.get('cache_read_input_tokens',0)
    cached=u.get('cache_read_input_tokens',0)+u.get('cache_creation_input_tokens',0)
    out=u.get('output_tokens',0)
    print(inp, cached, out)
except: print('0 0 0')
" 2>/dev/null)
        read ri rc ro <<< "$TOKS"
        TOTAL_IN=$((TOTAL_IN + ri))
        TOTAL_CACHED=$((TOTAL_CACHED + rc))
        TOTAL_OUT=$((TOTAL_OUT + ro))
        BATCH_TOTAL=$((BATCH_TOTAL + ri + ro))
        RUNS=$((RUNS + 1))
    done
    TOTAL=$((TOTAL_IN + TOTAL_OUT))
    echo "    ${DUR}s · batch=$BATCH_TOTAL · total=$TOTAL · runs=$RUNS"

    # Check /status after each batch
    echo "    Checking /status..."
    MID="/tmp/claude_mid_${TS}_b${batch}.txt"
    capture_status "CHECK-b$batch" "$MID"
    MID_JSON=$(parse_status "$MID")
    MID_WEEKLY=$(echo "$MID_JSON" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('weekly_all_pct_used', -1))")
    DELTA=$((MID_WEEKLY - BEFORE_WEEKLY))
    echo "    Weekly: ${BEFORE_WEEKLY}% → ${MID_WEEKLY}% (delta: ${DELTA}%)"

    if [ "$DELTA" -ge "$MIN_PCT_CHANGE" ] 2>/dev/null; then
        echo "    ✓ Quota moved by ${DELTA}% — enough for estimate!"
        AFTER_JSON="$MID_JSON"
        AFTER_CAPTURED=1
        break
    else
        echo "    Not enough change yet, continuing..."
    fi
    echo ""
done
TOTAL=$((TOTAL_IN + TOTAL_OUT))
echo ""
echo "TASK TOTALS: $RUNS runs · ${TOTAL} tokens (in=$TOTAL_IN cached=$TOTAL_CACHED out=$TOTAL_OUT) · ${TOTAL_DUR}s"

# ═══════════════════════════════════════
# STEP 3: AFTER (skip if already captured in loop)
# ═══════════════════════════════════════
if [ "${AFTER_CAPTURED:-0}" != "1" ]; then
    AF="/tmp/claude_af_${TS}.txt"
    capture_status "AFTER" "$AF"
    AFTER_JSON=$(parse_status "$AF")
fi
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
