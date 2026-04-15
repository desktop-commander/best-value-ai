#!/usr/bin/env bash
# Fully automated Codex CLI subscription quota measurement
# Streams all progress to stdout. Final JSON result printed at end.
# Usage: bash scripts/measure-codex-quota.sh [working_directory]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$REPO_DIR/measurements"
mkdir -p "$RESULTS_DIR"
TS=$(date +%Y%m%d_%H%M%S)
RESULT_FILE="$RESULTS_DIR/codex_measurement_${TS}.json"
WORK_DIR="${1:-$(mktemp -d)}"
SN="codex_m_$$"
CODEX="npx codex"

echo "=== Codex Quota Measurement · $TS ==="
echo "Work dir: $WORK_DIR"

# Preflight
command -v tmux &>/dev/null || { echo "FAIL: tmux not found"; exit 1; }
$CODEX --version &>/dev/null 2>&1 || { echo "FAIL: codex not found"; exit 1; }
VER=$($CODEX --version 2>/dev/null || echo "unknown")
echo "Codex: $VER"

# Ensure git repo
[ -d "$WORK_DIR/.git" ] || { mkdir -p "$WORK_DIR"; cd "$WORK_DIR"; git init -q; echo "Init git in $WORK_DIR"; }

# ── Function: capture /status via tmux ──
capture_status() {
    local label="$1" outfile="$2"
    echo ""
    echo "--- $label: launching tmux ---"
    tmux kill-session -t "$SN" 2>/dev/null || true
    tmux new-session -d -s "$SN" -x 120 -y 50 "cd '$WORK_DIR' && $CODEX"

    echo "$label: waiting 18s for TUI..."
    sleep 18

    echo "$label: sending Escape..."
    tmux send-keys -t "$SN" Escape
    sleep 2

    echo "$label: sending /status Enter..."
    tmux send-keys -t "$SN" '/status'
    sleep 1
    tmux send-keys -t "$SN" Enter

    echo "$label: waiting 12s for rate limits..."
    sleep 12

    echo "$label: capturing screen..."
    tmux capture-pane -t "$SN" -p > "$outfile"

    # Check if we got data
    if grep -q "% left" "$outfile" 2>/dev/null; then
        echo "$label: ✓ captured successfully"
        grep "% left" "$outfile"
    else
        echo "$label: ⚠ no '% left' found, retrying..."
        tmux send-keys -t "$SN" Escape
        sleep 2
        tmux send-keys -t "$SN" '/status'
        sleep 1
        tmux send-keys -t "$SN" Enter
        sleep 15
        tmux capture-pane -t "$SN" -p > "$outfile"
        if grep -q "% left" "$outfile" 2>/dev/null; then
            echo "$label: ✓ retry succeeded"
            grep "% left" "$outfile"
        else
            echo "$label: ✗ FAILED after retry. Screen content:"
            head -25 "$outfile"
        fi
    fi

    echo "$label: killing tmux..."
    tmux kill-session -t "$SN" 2>/dev/null || true
}

# ── Function: parse status file → JSON ──
parse_status() {
    python3 -c "
import re, json
text = open('$1').read()
d = {}
m = re.search(r'5h limit:.*?(\d+)%\s*left', text)
if m: d['5h_pct_left'] = int(m.group(1))
m = re.search(r'Weekly limit:.*?(\d+)%\s*left', text)
if m: d['weekly_pct_left'] = int(m.group(1))
m = re.search(r'Account:\s*(.*?)(?:\n|│)', text)
if m:
    acct = m.group(1).strip()
    d['account'] = acct
    # Extract plan name: 'user@email.com (Plus)' → 'Plus'
    pm = re.search(r'\((\w+)\)', acct)
    if pm: d['plan'] = pm.group(1)
m = re.search(r'Model:\s*(.*?)(?:\n|│)', text)
if m: d['model'] = m.group(1).strip()
print(json.dumps(d))
"
}

# ═══════════════════════════════════════
# STEP 1: BEFORE
# ═══════════════════════════════════════
BF="/tmp/codex_bf_${TS}.txt"
capture_status "BEFORE" "$BF"
BEFORE_JSON=$(parse_status "$BF")
echo ""
echo "BEFORE=$BEFORE_JSON"

# ═══════════════════════════════════════
# STEP 2: RUN TASKS (5x for bigger delta)
# ═══════════════════════════════════════
echo ""
echo "--- TASK: running iterations ---"
PROMPT="Write a Python doubly-linked list with insert_head, insert_tail, delete_node, find, reverse, to_list. Include Node class, type hints, docstrings. Write exactly 10 pytest tests. Save to linked_list.py"
TOTAL_IN=0; TOTAL_CACHED=0; TOTAL_OUT=0; TOTAL_DUR=0; RUNS=0
NUM_RUNS=${NUM_RUNS:-5}

cd "$WORK_DIR"
for i in $(seq 1 $NUM_RUNS); do
    JF="/tmp/codex_run_${TS}_${i}.jsonl"
    echo "  Run $i/$NUM_RUNS..."
    T0=$(date +%s)
    echo "$PROMPT" | $CODEX exec --json - > "$JF" 2>/dev/null || true
    T1=$(date +%s)
    DUR=$((T1 - T0))
    TOTAL_DUR=$((TOTAL_DUR + DUR))
    RUNS=$((RUNS + 1))

    # Parse tokens
    TOKS=$(python3 -c "
import json
i=c=o=0
for l in open('$JF'):
    try:
        d=json.loads(l.strip())
        if d.get('type')=='turn.completed':
            u=d.get('usage',{})
            i+=u.get('input_tokens',0)
            c+=u.get('cached_input_tokens',0)
            o+=u.get('output_tokens',0)
    except: pass
print(i,c,o)
")
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
AF="/tmp/codex_af_${TS}.txt"
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

b5 = before.get('5h_pct_left')
a5 = after.get('5h_pct_left')
bw = before.get('weekly_pct_left')
aw = after.get('weekly_pct_left')
total = $TOTAL
years = 3

est = {}

if b5 is not None and a5 is not None:
    d5 = b5 - a5
    print(f'5h delta: {b5}% -> {a5}% = {d5}% consumed')
    if d5 > 0:
        e = int(total / (d5/100))
        est['5h_tokens'] = e
        print(f'5h estimate: {e:,} ({e/1e6:.1f}M)')
    else:
        print(f'5h delta = {d5}%, cannot estimate')
else:
    d5 = None
    print('5h: missing data')

if bw is not None and aw is not None:
    dw = bw - aw
    print(f'Weekly delta: {bw}% -> {aw}% = {dw}% consumed')
    if dw > 0:
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
    'tool': 'codex-cli', 'version': '$VER',
    'plan': after.get('plan', before.get('plan', 'unknown')),
    'account': after.get('account', before.get('account', 'unknown')),
    'model': after.get('model', before.get('model', 'unknown')),
    'timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'task': 'doubly-linked-list-with-tests',
    'num_runs': $RUNS, 'duration_seconds': $TOTAL_DUR,
    'tokens': {'input': $TOTAL_IN, 'cached': $TOTAL_CACHED, 'output': $TOTAL_OUT, 'total': $TOTAL},
    'quota_before': before, 'quota_after': after,
    'quota_consumed': {'5h_pct': d5, 'weekly_pct': dw},
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
