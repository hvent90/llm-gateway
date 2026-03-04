#!/bin/bash
# Ralph Perf — Autonomous performance optimization loop
# Runs until all properties in perf-prd.json pass

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RALPH_MD="$SCRIPT_DIR/RALPH-PERF.md"
MAX_ITERATIONS=200
LOG_FILE="$SCRIPT_DIR/ralph-perf.log"

echo "Starting Ralph Perf loop..."
echo "Worktree: $SCRIPT_DIR"
echo "Max iterations: $MAX_ITERATIONS"
echo "Log file: $LOG_FILE"
echo ""

for i in $(seq 1 $MAX_ITERATIONS); do
  echo "==============================================================="
  echo "  Ralph Perf — Iteration $i of $MAX_ITERATIONS"
  echo "  $(date '+%Y-%m-%d %H:%M:%S')"
  echo "==============================================================="

  # Show current PRD status
  echo ""
  echo "Property status:"
  if command -v jq &>/dev/null; then
    jq -r '.properties[] | "  \(.id) [\(if .passes then "PASS" else "TODO" end)] \(.name)"' "$SCRIPT_DIR/perf-prd.json"
  else
    grep -o '"id":"[^"]*"\|"passes":[a-z]*\|"name":"[^"]*"' "$SCRIPT_DIR/perf-prd.json" || true
  fi
  echo ""

  # Run Claude Code with RALPH-PERF.md instructions
  OUTPUT=$(cd "$SCRIPT_DIR" && claude --dangerously-skip-permissions --print < "$RALPH_MD" 2>&1 | tee /dev/stderr) || true

  # Log iteration summary
  echo "--- Iteration $i $(date '+%Y-%m-%d %H:%M:%S') ---" >> "$LOG_FILE"
  echo "$OUTPUT" | tail -20 >> "$LOG_FILE"
  echo "" >> "$LOG_FILE"

  # Check for completion signal
  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo ""
    echo "==============================================================="
    echo "  Ralph Perf completed all properties!"
    echo "==============================================================="
    echo "Completed at iteration $i of $MAX_ITERATIONS"
    echo ""
    echo "Final property status:"
    jq -r '.properties[] | "  \(.id) [\(if .passes then "PASS" else "TODO" end)] \(.name)"' "$SCRIPT_DIR/perf-prd.json" 2>/dev/null || true
    exit 0
  fi

  echo ""
  echo "Iteration $i complete. Continuing in 2 seconds..."
  sleep 2
done

echo ""
echo "==============================================================="
echo "  Ralph Perf reached max iterations ($MAX_ITERATIONS)"
echo "==============================================================="
echo "Check perf-prd.json and perf-progress.txt for current state."
exit 1
