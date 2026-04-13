#!/usr/bin/env bash
# LLM Value Comparison — Subscription Token Quota Measurement Script
#
# Measures how many tokens your subscription plan provides by:
# 1. Running a standardized task with --json to get exact token counts
# 2. Comparing /status before and after to get quota percentage consumed
# 3. Calculating: total_tokens / (pct_consumed / 100) = estimated quota
#
# Works with: Codex CLI (Plus $20, Pro $100)
# For Claude Code, use measure-claude-quota.sh instead
#
# Usage:
#   bash scripts/measure-codex-quota.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$REPO_DIR/measurements"
mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TASK_DIR=$(mktemp -d)
RESULT_FILE="$RESULTS_DIR/codex_measurement_${TIMESTAMP}.json"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  LLM Value Comparison — Codex Token Quota Measurement       ║"
echo "║  https://desktop-commander.github.io/llm-value-comparison   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Check codex is available
if ! command -v codex &>/dev/null && ! npx codex --version &>/dev/null 2>&1; then
    echo "✗ Codex CLI not found. Install: npm install -g @openai/codex"
    exit 1
fi
CODEX="npx codex"
echo "✓ Codex CLI found"

# Get version and model info
VERSION=$($CODEX --version 2>/dev/null || echo "unknown")
echo "  Version: $VERSION"
echo ""

# Step 1: Record status BEFORE
echo "═══ Step 1: Record current quota status ═══"
echo ""
echo "Please run '/status' in an interactive Codex session and enter the numbers:"
echo "(Or check https://chatgpt.com/codex/settings/usage)"
echo ""
read -p "  5-hour limit % LEFT (e.g., 91): " BEFORE_5H
read -p "  Weekly limit % LEFT (e.g., 94): " BEFORE_WEEKLY
echo ""


# Step 2: Set up workspace
cd "$TASK_DIR"
git init -q

# Step 3: Run standardized task with --json
echo "═══ Step 2: Running standardized coding task ═══"
echo ""
TASK_PROMPT="Write a Python doubly-linked list with insert_head, insert_tail, delete_node, find, reverse, to_list methods. Include Node class, type hints, docstrings. Write exactly 10 pytest tests. Save to linked_list.py"
echo "  Task: Doubly-linked list + 10 pytest tests"
echo "  This will consume some of your quota."
echo ""

JSONL_FILE="$TASK_DIR/codex_output.jsonl"
echo "$TASK_PROMPT" | $CODEX exec --json - > "$JSONL_FILE" 2>"$TASK_DIR/stderr.log"

echo "  ✓ Task completed"
echo ""

# Step 4: Parse token counts from JSONL
echo "═══ Step 3: Parsing token counts ═══"
echo ""

# Extract all turn.completed usage events
TOTAL_INPUT=0
TOTAL_CACHED=0
TOTAL_OUTPUT=0

while IFS= read -r line; do
    type=$(echo "$line" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('type',''))" 2>/dev/null)
    if [ "$type" = "turn.completed" ]; then
        usage=$(echo "$line" | python3 -c "
import sys,json
d=json.loads(sys.stdin.read())
u=d.get('usage',{})
print(u.get('input_tokens',0), u.get('cached_input_tokens',0), u.get('output_tokens',0))
" 2>/dev/null)
        read inp cached out <<< "$usage"
        TOTAL_INPUT=$((TOTAL_INPUT + inp))
        TOTAL_CACHED=$((TOTAL_CACHED + cached))
        TOTAL_OUTPUT=$((TOTAL_OUTPUT + out))
    fi
done < "$JSONL_FILE"

TOTAL_TOKENS=$((TOTAL_INPUT + TOTAL_OUTPUT))
echo "  Input tokens:  $TOTAL_INPUT (cached: $TOTAL_CACHED)"
echo "  Output tokens: $TOTAL_OUTPUT"
echo "  Total tokens:  $TOTAL_TOKENS"
echo ""


# Step 5: Record status AFTER
echo "═══ Step 4: Record quota status after task ═══"
echo ""
echo "Run '/status' again in Codex and enter the new numbers:"
echo ""
read -p "  5-hour limit % LEFT (e.g., 88): " AFTER_5H
read -p "  Weekly limit % LEFT (e.g., 92): " AFTER_WEEKLY
echo ""

# Step 6: Calculate estimates
echo "═══ Step 5: Calculating quota estimates ═══"
echo ""

CONSUMED_5H=$(echo "$BEFORE_5H - $AFTER_5H" | bc)
CONSUMED_WEEKLY=$(echo "$BEFORE_WEEKLY - $AFTER_WEEKLY" | bc)

echo "  Quota consumed: ${CONSUMED_5H}% of 5h window, ${CONSUMED_WEEKLY}% of weekly"

if [ "$CONSUMED_5H" -gt 0 ] 2>/dev/null; then
    EST_5H=$(python3 -c "print(int($TOTAL_TOKENS / ($CONSUMED_5H / 100)))")
    EST_5H_M=$(python3 -c "print(f'{$TOTAL_TOKENS / ($CONSUMED_5H / 100) / 1e6:.1f}M')")
    echo "  Estimated 5h window: $EST_5H tokens ($EST_5H_M)"
else
    EST_5H="unknown"
    EST_5H_M="unknown"
    echo "  ⚠ Could not calculate 5h estimate (0% consumed)"
fi

if [ "$CONSUMED_WEEKLY" -gt 0 ] 2>/dev/null; then
    EST_WEEKLY=$(python3 -c "print(int($TOTAL_TOKENS / ($CONSUMED_WEEKLY / 100)))")
    EST_WEEKLY_M=$(python3 -c "print(f'{$TOTAL_TOKENS / ($CONSUMED_WEEKLY / 100) / 1e6:.1f}M')")
    echo "  Estimated weekly:    $EST_WEEKLY tokens ($EST_WEEKLY_M)"
else
    EST_WEEKLY="unknown"
    EST_WEEKLY_M="unknown"
    echo "  ⚠ Could not calculate weekly estimate (0% consumed)"
fi
echo ""


# Step 7: Get plan info
read -p "  Your plan (plus/pro/team): " PLAN_NAME
echo ""

# Step 8: Save results
cat > "$RESULT_FILE" << ENDJSON
{
  "tool": "codex-cli",
  "version": "$VERSION",
  "plan": "$PLAN_NAME",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "task": "doubly-linked-list-with-tests",
  "tokens": {
    "input": $TOTAL_INPUT,
    "cached_input": $TOTAL_CACHED,
    "output": $TOTAL_OUTPUT,
    "total": $TOTAL_TOKENS
  },
  "quota_before": { "5h_pct_left": $BEFORE_5H, "weekly_pct_left": $BEFORE_WEEKLY },
  "quota_after": { "5h_pct_left": $AFTER_5H, "weekly_pct_left": $AFTER_WEEKLY },
  "quota_consumed": { "5h_pct": $CONSUMED_5H, "weekly_pct": $CONSUMED_WEEKLY },
  "estimates": {
    "5h_window_tokens": "$EST_5H",
    "weekly_tokens": "$EST_WEEKLY",
    "5h_readable": "$EST_5H_M",
    "weekly_readable": "$EST_WEEKLY_M"
  }
}
ENDJSON

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Measurement complete!                                      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Results: $RESULT_FILE"
echo ""
echo "Submit via PR or issue:"
echo "  https://github.com/desktop-commander/llm-value-comparison/issues/new"
echo ""

# Cleanup
rm -rf "$TASK_DIR"
