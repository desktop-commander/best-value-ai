#!/usr/bin/env bash
# Fully automated Claude Code subscription quota measurement
# Streams all progress to stdout. Final JSON result printed at end.
# Usage: bash scripts/measure-claude-quota.sh [working_directory] [model_alias]
# Model alias examples: opus, sonnet, haiku
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$REPO_DIR/measurements"
mkdir -p "$RESULTS_DIR"
TS=$(date +%Y%m%d_%H%M%S)
RESULT_FILE="$RESULTS_DIR/claude_measurement_${TS}.json"
WORK_DIR="${1:-$REPO_DIR}"
MODEL_ALIAS="${2:-${MODEL_ALIAS:-default}}"
SN="claude_m_$$"
# Ensure work dir exists — otherwise the inner `cd` in the tmux launch command
# fails silently and tmux exits before we can capture anything, producing the
# very unhelpful "can't find pane: claude_m_<pid>" error.
mkdir -p "$WORK_DIR"

echo "=== Claude Code Quota Measurement · $TS ==="
echo "Work dir: $WORK_DIR"
echo "Requested model: $MODEL_ALIAS"

# Preflight
command -v tmux &>/dev/null || { echo "FAIL: tmux not found"; exit 1; }
command -v claude &>/dev/null || { echo "FAIL: claude not found"; exit 1; }
VER=$(claude --version 2>/dev/null || echo "unknown")
echo "Claude Code: $VER"

# ── Function: launch Claude TUI with explicit model selection if requested ──
launch_claude_session() {
    local label="$1"
    local cmd="claude"
    if [ "$MODEL_ALIAS" != "default" ]; then
        cmd="claude --model $MODEL_ALIAS"
    fi

    echo "$label: launching command: $cmd"
    tmux new-session -d -s "$SN" -x 120 -y 50 "cd '$WORK_DIR' && $cmd"
}

# ── Function: capture /status Usage tab via tmux ──
capture_status() {
    local label="$1" outfile="$2"
    echo ""
    echo "--- $label: launching tmux ---"
    tmux kill-session -t "$SN" 2>/dev/null || true
    launch_claude_session "$label"

    echo "$label: waiting 10s for TUI..."
    sleep 10

    # Check for trust dialog
    local screen=$(tmux capture-pane -t "$SN" -p)
    if echo "$screen" | grep -q "trust the files"; then
        echo "$label: accepting trust dialog..."
        tmux send-keys -t "$SN" Enter
        sleep 5
        screen=$(tmux capture-pane -t "$SN" -p)
    fi

    # Capture welcome screen for plan/model info before navigating away
    tmux capture-pane -t "$SN" -p > "/tmp/claude_welcome_${TS}.txt"

    # Note: in older Claude Code versions we sent Escape here to clear any
    # initial dialog before /status. In 2.1.119+ that appears to trigger an
    # exit from the main prompt, killing the tmux pane. Going directly to
    # /status from the welcome screen instead.
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
import re, json, os
text = open('$1').read()
d = {}
m = re.search(r'Current session.*?(\d+)%\s*used', text, re.DOTALL)
if m: d['session_pct_used'] = int(m.group(1))
m = re.search(r'Current week \(all models\).*?(\d+)%\s*used', text, re.DOTALL)
if m: d['weekly_all_pct_used'] = int(m.group(1))
m = re.search(r'Current week \(Sonnet only\).*?(\d+)%\s*used', text, re.DOTALL)
if m: d['weekly_sonnet_pct_used'] = int(m.group(1))
m = re.search(r'Current week \(Opus only\).*?(\d+)%\s*used', text, re.DOTALL)
if m: d['weekly_opus_pct_used'] = int(m.group(1))
d['requested_model_alias'] = '$MODEL_ALIAS'
# Read plan/model from welcome screen
wf = '/tmp/claude_welcome_${TS}.txt'
if os.path.exists(wf):
    wt = open(wf).read()
    # Welcome screen shows 'Sonnet 4.6 · Claude Max' or 'Opus 4.7 · Claude Pro'
    m = re.search(r'((?:Sonnet|Opus|Haiku)\s+[\d.]+)\s*·\s*(Claude (?:Pro|Max(?:\s*\d+x)?))', wt)
    if m:
        d['model'] = m.group(1)
        d['plan'] = m.group(2)
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
# Anthropic's pricing distinguishes 3 input buckets, NOT 2:
#   input_tokens               = fresh tokens, full price (1×)
#   cache_creation_input_tokens = new tokens being WRITTEN to cache, 1.25× input price
#   cache_read_input_tokens    = pre-existing cache reused, 0.10× input price
# Earlier versions of this script collapsed cache_creation+cache_read into a
# single "cached" bucket, which is wrong: cache_creation is paid at FULL price
# (with a 25% write premium), not the 10% read discount. We track all three
# separately now so downstream API-equivalent calculations get the pricing
# right.
TOTAL_IN=0; TOTAL_CACHE_CREATION=0; TOTAL_CACHE_READ=0; TOTAL_OUT=0; TOTAL_DUR=0; RUNS=0
MAX_BATCHES=${MAX_BATCHES:-40}
PARALLEL=${PARALLEL:-10}
TARGET_METER=${TARGET_METER:-weekly_all_pct_used}
TARGET_FLIPS=${TARGET_FLIPS:-3}
# CACHE_BUST=1 prepends a unique nonce per run. CORRECTED finding (Apr 26
# 2026) after fixing the cache_read/cache_creation bookkeeping: cache_bust
# DOES affect Claude Code measurably. With the bug in place we saw
# 99.99% → 99.99% which looked like no effect. With correct accounting,
# Claude Code drops from ~92% cache_read to ~77% cache_read when nonces
# are added. Codex side remains ~88% → ~88% (cache_bust appears not to
# affect Codex meaningfully). Logged as cache_bust in output JSON.
CACHE_BUST=${CACHE_BUST:-0}
FLIPS_RECORDED=0
FLIP_JSON_LINES=""
LAST_METER_VALUE=$(echo "$BEFORE_JSON" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('$TARGET_METER', -1))")

if [ "$LAST_METER_VALUE" -lt 0 ] 2>/dev/null; then
    echo "FAIL: target meter '$TARGET_METER' not found in Claude /status output"
    exit 1
fi

echo "Target meter: $TARGET_METER"
echo "Target flips: $TARGET_FLIPS"
echo "Starting meter value: ${LAST_METER_VALUE}%"
echo "Parallel: $PARALLEL tasks per batch, max $MAX_BATCHES batches"
echo "Cache bust: $([ "$CACHE_BUST" = "1" ] && echo "ON (unique prefix per run, kills cache)" || echo "off (default — cached repetition)")"
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
        # Build per-run prompt. With CACHE_BUST=1, prepend unique nonce so
        # Anthropic's prompt-prefix cache misses on every run.
        if [ "$CACHE_BUST" = "1" ]; then
            NONCE="run_${RUN_NUM}_$(date +%s)_$RANDOM"
            RUN_PROMPT="[Session $NONCE] $PROMPT"
        else
            RUN_PROMPT="$PROMPT"
        fi
        if [ "$MODEL_ALIAS" = "default" ]; then
            (echo "" | claude -p "$RUN_PROMPT" --output-format json > "$JF" 2>/dev/null) &
        else
            (echo "" | claude --model "$MODEL_ALIAS" -p "$RUN_PROMPT" --output-format json > "$JF" 2>/dev/null) &
        fi
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
        # Pull the three Anthropic input buckets separately so we don't lose
        # the distinction between full-price cache writes and discounted reads.
        TOKS=$(python3 -c "
import json
try:
    d=json.load(open('$JF'))
    u=d.get('usage',{})
    inp=u.get('input_tokens',0)
    cc=u.get('cache_creation_input_tokens',0)
    cr=u.get('cache_read_input_tokens',0)
    out=u.get('output_tokens',0)
    print(inp, cc, cr, out)
except: print('0 0 0 0')
" 2>/dev/null)
        read ri rcc rcr ro <<< "$TOKS"
        TOTAL_IN=$((TOTAL_IN + ri))
        TOTAL_CACHE_CREATION=$((TOTAL_CACHE_CREATION + rcc))
        TOTAL_CACHE_READ=$((TOTAL_CACHE_READ + rcr))
        TOTAL_OUT=$((TOTAL_OUT + ro))
        # "Real input" the model saw is the sum of all three input buckets
        run_input_total=$((ri + rcc + rcr))
        BATCH_TOTAL=$((BATCH_TOTAL + run_input_total + ro))
        RUNS=$((RUNS + 1))
    done
    TOTAL=$((TOTAL_IN + TOTAL_CACHE_CREATION + TOTAL_CACHE_READ + TOTAL_OUT))
    echo "    ${DUR}s · batch=$BATCH_TOTAL · total=$TOTAL · runs=$RUNS"

    # Check /status after each batch
    echo "    Checking /status..."
    MID="/tmp/claude_mid_${TS}_b${batch}.txt"
    capture_status "CHECK-b$batch" "$MID"
    MID_JSON=$(parse_status "$MID")
    MID_TARGET=$(echo "$MID_JSON" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('$TARGET_METER', -1))")
    DELTA=$((MID_TARGET - LAST_METER_VALUE))
    echo "    ${TARGET_METER}: ${LAST_METER_VALUE}% → ${MID_TARGET}% (delta this check: ${DELTA}%)"

    if [ "$MID_TARGET" -gt "$LAST_METER_VALUE" ] 2>/dev/null; then
        for meter in $(seq $((LAST_METER_VALUE + 1)) "$MID_TARGET"); do
            FLIPS_RECORDED=$((FLIPS_RECORDED + 1))
            FLIP_JSON_LINES="${FLIP_JSON_LINES}{\"flip_index\":${FLIPS_RECORDED},\"meter_value\":${meter},\"cumulative_tokens\":${TOTAL},\"runs\":${RUNS},\"batch\":${batch}},"
            echo "    ✓ recorded flip #${FLIPS_RECORDED}: ${meter}% at ${TOTAL} tokens"
            if [ "$FLIPS_RECORDED" -ge "$TARGET_FLIPS" ] 2>/dev/null; then
                AFTER_JSON="$MID_JSON"
                AFTER_CAPTURED=1
                break 2
            fi
        done
        LAST_METER_VALUE=$MID_TARGET
    else
        echo "    No new flip yet, continuing..."
    fi
    echo ""
done
TOTAL=$((TOTAL_IN + TOTAL_CACHE_CREATION + TOTAL_CACHE_READ + TOTAL_OUT))
echo ""
echo "TASK TOTALS: $RUNS runs · ${TOTAL} tokens (input=$TOTAL_IN cache_creation=$TOTAL_CACHE_CREATION cache_read=$TOTAL_CACHE_READ output=$TOTAL_OUT) · ${TOTAL_DUR}s"

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
import statistics
from datetime import datetime, timezone

before = json.loads('$BEFORE_JSON')
after = json.loads('$AFTER_JSON')
total = $TOTAL
flip_lines = '''$FLIP_JSON_LINES'''.strip()
flips = []
if flip_lines:
    flips = json.loads('[' + flip_lines.rstrip(',') + ']')

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
        e = int(total / (ds / 100))
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
        e = int(total / (dw / 100))
        daily = e // 7
        est['weekly_tokens'] = e
        est['daily_tokens'] = daily
        print(f'Weekly estimate: {e:,} ({e/1e6:.1f}M), daily: {daily:,} ({daily/1e6:.1f}M)')
    else:
        print(f'Weekly delta = {dw}%, cannot estimate')
else:
    dw = None
    print('Weekly: missing data')

target_before = before.get('$TARGET_METER')
target_after = after.get('$TARGET_METER')
target_delta = None
if target_before is not None and target_after is not None:
    target_delta = target_after - target_before

all_flip_deltas = []
prev_tokens = 0
for flip in flips:
    all_flip_deltas.append(flip['cumulative_tokens'] - prev_tokens)
    prev_tokens = flip['cumulative_tokens']

usable_flip_deltas = all_flip_deltas[1:] if len(all_flip_deltas) > 1 else []

if usable_flip_deltas:
    mean_delta = statistics.mean(usable_flip_deltas)
    median_delta = statistics.median(usable_flip_deltas)
    est['target_meter_mean_tokens_per_1pct'] = round(mean_delta)
    est['target_meter_median_tokens_per_1pct'] = round(median_delta)
    est['target_meter_estimate_mean'] = round(mean_delta * 100)
    est['target_meter_estimate_median'] = round(median_delta * 100)
    est['target_meter_flip_count'] = len(usable_flip_deltas)
    est['target_meter_flip_deltas'] = usable_flip_deltas
    est['target_meter_all_flip_deltas'] = all_flip_deltas
    est['target_meter_ignored_first_flip'] = True
    print(f'Target meter flips recorded: {len(all_flip_deltas)}')
    print('Ignoring first flip delta because the starting position inside that 1% bucket is unknown')
    print(f'Usable target meter flips: {len(usable_flip_deltas)}')
    print(f'Mean tokens / 1%: {mean_delta:,.0f}')
    print(f'Median tokens / 1%: {median_delta:,.0f}')
elif all_flip_deltas:
    est['target_meter_all_flip_deltas'] = all_flip_deltas
    est['target_meter_ignored_first_flip'] = True
    print('Only one flip recorded; after ignoring the first flip, no usable flip deltas remain')
else:
    print('No target meter flips recorded')

result = {
    'tool': 'claude-code',
    'version': '$VER',
    'plan': after.get('plan', before.get('plan', 'unknown')),
    'requested_model_alias': '$MODEL_ALIAS',
    'captured_model': after.get('model', before.get('model', 'unknown')),
    'target_meter': '$TARGET_METER',
    'target_flips_requested': $TARGET_FLIPS,
    'model': after.get('model', before.get('model', 'unknown')),
    'timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'task': 'doubly-linked-list-with-tests',
    'num_runs': $RUNS,
    'parallel': $PARALLEL,
    'cache_bust': $CACHE_BUST,
    'duration_seconds': $TOTAL_DUR,
    'schema_version': 2,
    'tokens': {
        # NEW: three explicit Anthropic buckets (schema_version=2+)
        'fresh_input': $TOTAL_IN,
        'cache_creation': $TOTAL_CACHE_CREATION,
        'cache_read': $TOTAL_CACHE_READ,
        'output': $TOTAL_OUT,
        'total': $TOTAL,
        # LEGACY fields kept for backward compatibility with older parsers.
        # 'input' = sum of all three input buckets (what the model actually saw)
        # 'cached' = cache_read ONLY (what gets the 10% discount tier in API pricing)
        # Older files had 'cached' = cache_creation + cache_read which was wrong.
        'input': $((TOTAL_IN + TOTAL_CACHE_CREATION + TOTAL_CACHE_READ)),
        'cached': $TOTAL_CACHE_READ
    },
    'quota_before': before,
    'quota_after': after,
    'quota_consumed': {
        'session_pct': ds,
        'weekly_all_pct': dw,
        'target_meter_pct': target_delta,
    },
    'meter_flips': flips,
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
