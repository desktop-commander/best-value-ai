#!/usr/bin/env bash
# LLM Value Comparison — Subscription Token Quota Measurement Script
#
# Measures how many tokens your subscription plan actually provides
# by running a standardized task and observing quota consumption.
#
# Works with:
#   - Claude Code (Pro $20, Max5 $100, Max20 $200)
#   - Codex CLI (Plus $20, Pro $100)
#
# Usage:
#   bash scripts/measure-subscription-quota.sh
#
# The script will:
#   1. Detect which tool you're using (claude or codex)
#   2. Record your current quota usage
#   3. Run a standardized coding task
#   4. Record quota usage after
#   5. Calculate estimated total tokens per period
#   6. Output results as JSON for submission

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/../measurements"
mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  LLM Value Comparison — Token Quota Measurement        ║"
echo "║  https://desktop-commander.github.io/best-value-ai ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# --- Detect tool ---
TOOL=""
if command -v claude &>/dev/null; then
    TOOL="claude"
    echo "✓ Detected: Claude Code"
elif command -v codex &>/dev/null; then
    TOOL="codex"
    echo "✓ Detected: Codex CLI"
else
    echo "✗ Neither 'claude' nor 'codex' CLI found in PATH."
    echo "  Install Claude Code: npm install -g @anthropic-ai/claude-code"
    echo "  Install Codex CLI:   npm install -g @openai/codex"
    exit 1
fi
echo ""

# --- Standardized task prompt ---
# This prompt is designed to produce a consistent, measurable token count.
# It asks for a specific, deterministic output that shouldn't vary much between runs.
TASK_PROMPT='Write a Python implementation of a doubly-linked list with these exact methods: insert_head, insert_tail, delete_node, find, reverse, to_list. Include a Node class. Include docstrings for each method. Include type hints. Write exactly 10 unit tests using pytest. Output only the code, no explanations.'

# Create a temp directory for the task
TASK_DIR=$(mktemp -d)
echo "# Measurement task workspace" > "$TASK_DIR/README.md"

# --- Measure function for Claude Code ---
measure_claude() {
    echo "=== Claude Code Measurement ==="
    echo ""
    echo "Step 1: Checking current usage..."
    echo "  Running: claude --print-only /status"
    echo ""

    # Capture /status output before the task
    STATUS_BEFORE=$(claude -p "/status" 2>/dev/null || echo "STATUS_FAILED")
    echo "  Before: $STATUS_BEFORE" | head -20
    echo ""

    # Also capture /cost for baseline
    COST_BEFORE=$(claude -p "/cost" 2>/dev/null || echo "COST_FAILED")

    echo "Step 2: Running standardized task..."
    echo "  Task: Doubly-linked list with tests (~150 lines expected output)"
    echo "  This will consume some of your quota. Press Ctrl+C to cancel."
    echo ""
    read -p "  Press Enter to continue (or Ctrl+C to abort)... "
    echo ""

    # Run the task in non-interactive mode
    TASK_START=$(date +%s)
    claude -p "$TASK_PROMPT" --output-file "$TASK_DIR/solution.py" 2>"$TASK_DIR/claude_stderr.log" || true
    TASK_END=$(date +%s)
    TASK_DURATION=$((TASK_END - TASK_START))

    echo "  Task completed in ${TASK_DURATION}s"
    if [ -f "$TASK_DIR/solution.py" ]; then
        LINES=$(wc -l < "$TASK_DIR/solution.py")
        CHARS=$(wc -c < "$TASK_DIR/solution.py")
        echo "  Output: ${LINES} lines, ${CHARS} chars"
    fi
    echo ""

    echo "Step 3: Checking usage after task..."
    STATUS_AFTER=$(claude -p "/status" 2>/dev/null || echo "STATUS_FAILED")
    echo "  After: $STATUS_AFTER" | head -20
    echo ""

    COST_AFTER=$(claude -p "/cost" 2>/dev/null || echo "COST_FAILED")

    # Save all raw data
    RESULT_FILE="$RESULTS_DIR/claude_measurement_${TIMESTAMP}.json"
    cat > "$RESULT_FILE" << ENDJSON
{
  "tool": "claude-code",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "task_duration_seconds": $TASK_DURATION,
  "output_lines": ${LINES:-0},
  "output_chars": ${CHARS:-0},
  "status_before": $(echo "$STATUS_BEFORE" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || echo '"parse_failed"'),
  "status_after": $(echo "$STATUS_AFTER" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || echo '"parse_failed"'),
  "cost_before": $(echo "$COST_BEFORE" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || echo '"parse_failed"'),
  "cost_after": $(echo "$COST_AFTER" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || echo '"parse_failed"'),
  "task_prompt_chars": ${#TASK_PROMPT},
  "plan": "unknown — please edit this field with your plan (pro/max5/max20)",
  "notes": "please add any relevant context"
}
ENDJSON

    echo "✓ Results saved to: $RESULT_FILE"
}

# --- Measure function for Codex CLI ---
measure_codex() {
    echo "=== Codex CLI Measurement ==="
    echo ""
    echo "Step 1: Checking current usage..."
    echo ""

    # Codex doesn't have a direct /status command in CLI
    # We use codex --usage or check the web dashboard
    CODEX_STATUS_BEFORE=$(codex --usage 2>/dev/null || echo "NO_CLI_STATUS")
    echo "  Before: $CODEX_STATUS_BEFORE" | head -20
    echo ""
    echo "  NOTE: If status shows 'NO_CLI_STATUS', check your usage at:"
    echo "  https://chatgpt.com/settings (Usage section)"
    echo "  Write down your current 5-hour % and weekly % before continuing."
    echo ""

    read -p "  Enter your current 5-hour usage % (or 'skip'): " USAGE_BEFORE_5H
    read -p "  Enter your current weekly usage % (or 'skip'): " USAGE_BEFORE_WEEKLY
    echo ""

    echo "Step 2: Running standardized task..."
    echo "  This will consume some of your quota. Press Ctrl+C to cancel."
    echo ""
    read -p "  Press Enter to continue (or Ctrl+C to abort)... "
    echo ""

    TASK_START=$(date +%s)
    codex -q "$TASK_PROMPT" > "$TASK_DIR/solution.py" 2>"$TASK_DIR/codex_stderr.log" || true
    TASK_END=$(date +%s)
    TASK_DURATION=$((TASK_END - TASK_START))

    echo "  Task completed in ${TASK_DURATION}s"
    if [ -f "$TASK_DIR/solution.py" ]; then
        LINES=$(wc -l < "$TASK_DIR/solution.py")
        CHARS=$(wc -c < "$TASK_DIR/solution.py")
        echo "  Output: ${LINES} lines, ${CHARS} chars"
    fi
    echo ""

    echo "Step 3: Check your usage again..."
    CODEX_STATUS_AFTER=$(codex --usage 2>/dev/null || echo "NO_CLI_STATUS")
    echo "  After: $CODEX_STATUS_AFTER" | head -20
    echo ""

    read -p "  Enter your current 5-hour usage % (or 'skip'): " USAGE_AFTER_5H
    read -p "  Enter your current weekly usage % (or 'skip'): " USAGE_AFTER_WEEKLY
    echo ""

    RESULT_FILE="$RESULTS_DIR/codex_measurement_${TIMESTAMP}.json"
    cat > "$RESULT_FILE" << ENDJSON
{
  "tool": "codex-cli",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "task_duration_seconds": $TASK_DURATION,
  "output_lines": ${LINES:-0},
  "output_chars": ${CHARS:-0},
  "usage_before_5h_pct": "$USAGE_BEFORE_5H",
  "usage_before_weekly_pct": "$USAGE_BEFORE_WEEKLY",
  "usage_after_5h_pct": "$USAGE_AFTER_5H",
  "usage_after_weekly_pct": "$USAGE_AFTER_WEEKLY",
  "status_before_raw": $(echo "$CODEX_STATUS_BEFORE" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || echo '"parse_failed"'),
  "status_after_raw": $(echo "$CODEX_STATUS_AFTER" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || echo '"parse_failed"'),
  "task_prompt_chars": ${#TASK_PROMPT},
  "plan": "unknown — please edit with your plan (plus/pro)",
  "notes": "please add any relevant context"
}
ENDJSON

    echo "✓ Results saved to: $RESULT_FILE"
}

# --- Run measurement ---
if [ "$TOOL" = "claude" ]; then
    measure_claude
elif [ "$TOOL" = "codex" ]; then
    measure_codex
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Measurement complete!                                  ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Edit the JSON file to add your plan name"
echo "  2. Submit as a PR to:"
echo "     https://github.com/desktop-commander/best-value-ai"
echo ""
echo "  Or share the JSON contents in a GitHub issue:"
echo "     https://github.com/desktop-commander/best-value-ai/issues"
echo ""
echo "  Result file: $RESULT_FILE"
echo ""

# Cleanup temp dir
rm -rf "$TASK_DIR"
