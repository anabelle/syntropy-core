#!/bin/bash
set -euo pipefail

# ============================================
# PIXEL WORKER ENTRYPOINT
# Brain/Hands Architecture - Worker Container
# ============================================

echo "[WORKER] Starting worker container..."
echo "[WORKER] TASK_ID: ${TASK_ID:-not set}"
echo "[WORKER] Hostname: $(hostname)"
echo "[WORKER] Date: $(date -Iseconds)"

# ============================================
# GUARDRAILS
# ============================================
# These patterns are FORBIDDEN unless this is a deliberate syntropy-rebuild task

LEDGER="/pixel/data/task-ledger.json"
TASK_ID="${TASK_ID:-}"

if [[ -z "$TASK_ID" ]]; then
  echo "[WORKER] ERROR: TASK_ID environment variable not set"
  exit 1
fi

# Read task from ledger
if [[ ! -f "$LEDGER" ]]; then
  echo "[WORKER] ERROR: Task ledger not found at $LEDGER"
  exit 1
fi

TASK_JSON=$(jq -r ".tasks[] | select(.id == \"$TASK_ID\")" "$LEDGER")

if [[ -z "$TASK_JSON" || "$TASK_JSON" == "null" ]]; then
  echo "[WORKER] ERROR: Task $TASK_ID not found in ledger"
  exit 1
fi

TASK_TYPE=$(echo "$TASK_JSON" | jq -r '.type // "opencode"')
TASK_DESC=$(echo "$TASK_JSON" | jq -r '.payload.task')
TASK_CONTEXT=$(echo "$TASK_JSON" | jq -r '.payload.context // ""')

echo "[WORKER] Task Type: $TASK_TYPE"
echo "[WORKER] Task: ${TASK_DESC:0:200}..."

# ============================================
# GUARDRAIL CHECK FUNCTION
# ============================================
check_forbidden_commands() {
  local cmd="$1"
  
  # Allow syntropy rebuilds ONLY for syntropy-rebuild tasks
  if [[ "$TASK_TYPE" == "syntropy-rebuild" ]]; then
    echo "[WORKER] ℹ️  Syntropy rebuild allowed (deliberate self-rebuild task)"
    return 0
  fi
  
  # Forbidden patterns for regular tasks
  local FORBIDDEN_PATTERNS=(
    "docker compose.*syntropy.*build"
    "docker-compose.*syntropy.*build"
    "docker build.*syntropy"
    "docker compose up.*--build.*syntropy"
    "docker compose up -d --build$"  # Catches rebuild-all without specific service
  )
  
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if echo "$cmd" | grep -qiE "$pattern"; then
      echo "[WORKER] 🚫 GUARDRAIL: Command would rebuild syntropy: $cmd"
      echo "[WORKER] Self-modification of the brain is prohibited in regular tasks."
      echo "[WORKER] Use scheduleSelfRebuild() for intentional Syntropy updates."
      return 1
    fi
  done
  return 0
}

# Export for use by opencode if it shells out
export -f check_forbidden_commands
export TASK_TYPE

# ============================================
# UPDATE LEDGER: Mark as running
# ============================================
echo "[WORKER] Marking task as running..."
WORKER_ID=$(hostname)
START_TIME=$(date -Iseconds)

jq "(.tasks[] | select(.id == \"$TASK_ID\")).status = \"running\" | 
    (.tasks[] | select(.id == \"$TASK_ID\")).startedAt = \"$START_TIME\" |
    (.tasks[] | select(.id == \"$TASK_ID\")).workerId = \"$WORKER_ID\"" \
    "$LEDGER" > "$LEDGER.tmp" && mv "$LEDGER.tmp" "$LEDGER"

# ============================================
# PREPARE BRIEFING
# ============================================
BRIEFING="
=== WORKER TASK BRIEFING ===

CONTEXT:
- You are a WORKER container in the Pixel ecosystem
- You CAN modify code, run tests, restart services
- You CAN rebuild services: api, web, landing, agent, postgres, nginx
- CRITICAL: You MUST NOT rebuild the 'syntropy' service (it would kill your parent)

GUARDRAIL RULES:
✅ ALLOWED: docker compose up -d --build agent
✅ ALLOWED: docker compose up -d --build api web landing
✅ ALLOWED: docker compose restart syntropy
❌ FORBIDDEN: docker compose up -d --build (rebuilds ALL including syntropy)
❌ FORBIDDEN: docker compose up -d --build syntropy

YOUR TASK:
$TASK_DESC

${TASK_CONTEXT:+ADDITIONAL CONTEXT:
$TASK_CONTEXT}

When done, provide a clear summary of:
1. What you did
2. What changed
3. Any remaining issues
"

# ============================================
# EXECUTE WITH OPENCODE (HEADLESS MODE)
# ============================================
echo "[WORKER] Starting Opencode execution in headless mode..."
cd /pixel

# Log files - both in data (for ledger) and logs (for easy viewing)
OUTPUT_FILE="/pixel/data/worker-output-$TASK_ID.txt"
LIVE_LOG="/pixel/logs/worker-${TASK_ID:0:8}.log"
OPENCODE_LIVE_LOG="/pixel/logs/opencode_live.log"

EXIT_CODE=0

# Headless configuration
OPENCODE_MODEL="${OPENCODE_MODEL:-anthropic:claude-sonnet-4-20250514}"
WORKER_TIMEOUT_SECONDS="${WORKER_TIMEOUT_SECONDS:-2700}"  # 45 minutes default

echo "[WORKER] Using model: $OPENCODE_MODEL"
echo "[WORKER] Timeout: ${WORKER_TIMEOUT_SECONDS}s ($(( WORKER_TIMEOUT_SECONDS / 60 )) minutes)"
echo "[WORKER] Output file: $OUTPUT_FILE"
echo "[WORKER] Live log: $LIVE_LOG"

# Create log header
{
  echo "========================================"
  echo "WORKER TASK: $TASK_ID"
  echo "STARTED: $(date -Iseconds)"
  echo "MODEL: $OPENCODE_MODEL"
  echo "TIMEOUT: ${WORKER_TIMEOUT_SECONDS}s"
  echo "========================================"
  echo ""
} | tee "$LIVE_LOG" >> "$OPENCODE_LIVE_LOG"

# Run opencode HEADLESS with:
# 1. stdin from /dev/null (prevents blocking on prompts)
# 2. timeout to kill runaway tasks
# 3. CI=true env var (set in docker-compose) for non-interactive mode
# Output captured to multiple locations:
# - stdout (visible via docker logs)
# - $OUTPUT_FILE (stored in ledger)
# - $LIVE_LOG (task-specific log in logs/)
# - $OPENCODE_LIVE_LOG (shared log file for all worker runs)
timeout --signal=SIGTERM --kill-after=60 "$WORKER_TIMEOUT_SECONDS" \
  opencode run "$BRIEFING" \
    -m "$OPENCODE_MODEL" \
    --file /pixel/AGENTS.md \
    --file /pixel/CONTINUITY.md \
  </dev/null 2>&1 | tee "$OUTPUT_FILE" "$LIVE_LOG" | tee -a "$OPENCODE_LIVE_LOG" || EXIT_CODE=$?

# Handle timeout specifically
if [[ $EXIT_CODE -eq 124 ]]; then
  echo "[WORKER] ⚠️ TIMEOUT: Task exceeded ${WORKER_TIMEOUT_SECONDS}s limit"
  echo "TIMEOUT: Task exceeded ${WORKER_TIMEOUT_SECONDS}s limit" >> "$OUTPUT_FILE"
fi

# Log footer
{
  echo ""
  echo "========================================"
  echo "WORKER COMPLETED: $(date -Iseconds)"
  echo "EXIT CODE: $EXIT_CODE"
  echo "========================================"
} | tee -a "$LIVE_LOG" >> "$OPENCODE_LIVE_LOG"

# ============================================
# UPDATE LEDGER: Mark completion
# ============================================
FINAL_STATUS="completed"
[[ $EXIT_CODE -ne 0 ]] && FINAL_STATUS="failed"

END_TIME=$(date -Iseconds)
echo "[WORKER] Task $FINAL_STATUS with exit code $EXIT_CODE"

# Read output (last 10KB) and escape for JSON
OUTPUT_TAIL=""
if [[ -f "$OUTPUT_FILE" ]]; then
  OUTPUT_TAIL=$(tail -c 10000 "$OUTPUT_FILE" 2>/dev/null || echo "")
fi
OUTPUT_ESCAPED=$(echo "$OUTPUT_TAIL" | jq -Rs .)

jq "(.tasks[] | select(.id == \"$TASK_ID\")).status = \"$FINAL_STATUS\" | 
    (.tasks[] | select(.id == \"$TASK_ID\")).completedAt = \"$END_TIME\" |
    (.tasks[] | select(.id == \"$TASK_ID\")).exitCode = $EXIT_CODE |
    (.tasks[] | select(.id == \"$TASK_ID\")).output = $OUTPUT_ESCAPED" \
    "$LEDGER" > "$LEDGER.tmp" && mv "$LEDGER.tmp" "$LEDGER"

echo "[WORKER] Worker completed. Exit code: $EXIT_CODE"
exit $EXIT_CODE
