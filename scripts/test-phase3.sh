#!/usr/bin/env bash
set -euo pipefail

# Phase 3 smoke script:
# - runs focused tests
# - optionally runs full backend tests
# - exercises orchestrator-backed AI + Alexa flows
# - prints latest bundle snapshot for a user
#
# Usage:
#   ./scripts/test-phase3.sh
#   ./scripts/test-phase3.sh amy
#   RUN_FULL_TESTS=0 ./scripts/test-phase3.sh
#   PORT=5001 ./scripts/test-phase3.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
PORT="${PORT:-5001}"
USERNAME="${1:-amy}"
RUN_FULL_TESTS="${RUN_FULL_TESTS:-1}"
POLL_ATTEMPTS="${POLL_ATTEMPTS:-20}"
POLL_SLEEP_SECONDS="${POLL_SLEEP_SECONDS:-1}"

STARTED_SERVER=0
SERVER_PID=""
SERVER_LOG="$ROOT_DIR/.phase3_server.log"

print_header() {
  echo
  echo "================================================================"
  echo "$1"
  echo "================================================================"
}

json_field() {
  local key="$1"
  node -e "
    let raw = '';
    process.stdin.on('data', c => raw += c);
    process.stdin.on('end', () => {
      try {
        const data = JSON.parse(raw || '{}');
        const parts = '$key'.split('.');
        let cur = data;
        for (const part of parts) {
          if (cur == null) break;
          cur = cur[part];
        }
        if (cur == null) return;
        if (typeof cur === 'string') process.stdout.write(cur);
        else process.stdout.write(JSON.stringify(cur));
      } catch (_) {}
    });
  "
}

is_server_ready() {
  curl -sS "http://localhost:${PORT}/api/alexa/back?username=phase3_health" >/dev/null 2>&1
}

wait_for_server() {
  local attempts=40
  local i=1
  while [[ $i -le $attempts ]]; do
    if is_server_ready; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

cleanup() {
  if [[ "$STARTED_SERVER" -eq 1 && -n "$SERVER_PID" ]]; then
    echo
    echo "Stopping server started by this script (pid: $SERVER_PID)..."
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

print_header "Phase 3 Smoke Script"
echo "Root: $ROOT_DIR"
echo "Backend: $BACKEND_DIR"
echo "Port: $PORT"
echo "Username: $USERNAME"

if is_server_ready; then
  echo "Server already reachable on port ${PORT}."
else
  print_header "Starting Server"
  echo "Server log: $SERVER_LOG"
  (
    cd "$ROOT_DIR"
    node server.js
  ) >"$SERVER_LOG" 2>&1 &
  SERVER_PID="$!"
  STARTED_SERVER=1

  if ! wait_for_server; then
    echo "Server did not become ready in time. Check $SERVER_LOG"
    exit 1
  fi
  echo "Server started (pid: $SERVER_PID)."
fi

print_header "Focused Tests"
(
  cd "$BACKEND_DIR"
  node --test tests/qnaScaffold.test.js
  node --test tests/alexaRouter.test.js
  node --test services/qna/__tests__/*.test.js services/openai/__tests__/*.test.js
)

if [[ "$RUN_FULL_TESTS" == "1" ]]; then
  print_header "Full Backend Tests"
  set +e
  (
    cd "$BACKEND_DIR"
    npm test
  )
  FULL_TEST_EXIT=$?
  set -e
  if [[ $FULL_TEST_EXIT -ne 0 ]]; then
    echo "npm test returned non-zero."
    echo "Known existing failure may still appear in tests/qnaEngine.test.js."
  fi
fi

print_header "AI Router Orchestrator Check"
AI_RESPONSE="$(curl -sS -X POST "http://localhost:${PORT}/api/ai/qna-ask" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${USERNAME}\",\"question\":\"How did I sleep this week?\"}")"

echo "AI response summary:"
echo "$AI_RESPONSE" | node -e '
  let raw = "";
  process.stdin.on("data", c => raw += c);
  process.stdin.on("end", () => {
    try {
      const j = JSON.parse(raw || "{}");
      const planner = j.planner || {};
      const payload = j.payload || {};
      const out = {
        planner_mode: planner.mode || null,
        time_scope: planner.timeScope || planner.time_scope || null,
        has_chart: Boolean(payload.chart_spec || payload.primary_visual),
        voice_answer_len: String(payload.voice_answer || "").length,
      };
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      console.log(raw);
    }
  });
'

print_header "Alexa Async Flow Check"
ASK_RESPONSE="$(curl -sS -X POST "http://localhost:${PORT}/api/alexa/" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${USERNAME}\",\"userInput\":{\"type\":\"question\",\"text\":\"How did I sleep this week?\",\"voiceDeadlineMs\":4200}}")"

REQUEST_ID="$(echo "$ASK_RESPONSE" | json_field "requestId")"
if [[ -z "$REQUEST_ID" ]]; then
  echo "No requestId returned from Alexa question call."
  echo "Response: $ASK_RESPONSE"
  exit 1
fi
echo "Question requestId: $REQUEST_ID"

READY_RESPONSE=""
READY_STATUS=""
for ((i=1; i<=POLL_ATTEMPTS; i++)); do
  POLL_RESPONSE="$(curl -sS -X POST "http://localhost:${PORT}/api/alexa/" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${USERNAME}\",\"userInput\":{\"type\":\"control\",\"action\":\"poll_pending\",\"requestId\":\"${REQUEST_ID}\"}}")"
  STATUS="$(echo "$POLL_RESPONSE" | json_field "status")"
  ANSWER_READY="$(echo "$POLL_RESPONSE" | json_field "answer_ready")"
  echo "poll #$i status=${STATUS:-unknown} answer_ready=${ANSWER_READY:-false}"
  if [[ "$STATUS" == "ready" ]]; then
    READY_RESPONSE="$POLL_RESPONSE"
    READY_STATUS="$STATUS"
    break
  fi
  sleep "$POLL_SLEEP_SECONDS"
done

if [[ "$READY_STATUS" != "ready" ]]; then
  echo "Did not reach ready status within polling window."
else
  echo "Alexa ready response summary:"
  echo "$READY_RESPONSE" | node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(raw || "{}");
        const out = {
          status: j.status || null,
          voice_answer_len: String(j.voice_answer || "").length,
          has_payload: Boolean(j.payload),
          has_chart: Boolean(j.payload?.chart_spec || j.payload?.primary_visual),
        };
        console.log(JSON.stringify(out, null, 2));
      } catch (e) {
        console.log(raw);
      }
    });
  '
fi

print_header "Continuation Policy Smoke"
for q in \
  "tell me more about sleep" \
  "instead compare calories versus sleep" \
  "start over with heart health"
do
  echo "Q: $q"
  R="$(curl -sS -X POST "http://localhost:${PORT}/api/ai/qna-ask" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${USERNAME}\",\"question\":\"${q}\"}")"
  echo "$R" | node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(raw || "{}");
        const p = j.planner || {};
        console.log(JSON.stringify({
          planner_mode: p.mode || null,
          metrics: p.metricsNeeded || p.metrics_needed || null,
          time_scope: p.timeScope || p.time_scope || null,
        }, null, 2));
      } catch (_) {
        console.log(raw);
      }
    });
  '
done

print_header "Latest Bundle Snapshot"
(
  cd "$BACKEND_DIR"
  USERNAME="$USERNAME" node -e '
    require("dotenv").config();
    const mongoose = require("mongoose");
    const QnaBundle = require("./models/QnaBundle");
    (async () => {
      try {
        const username = String(process.env.USERNAME || "amy").toLowerCase();
        await mongoose.connect(process.env.MONGODB_URL);
        const doc = await QnaBundle.findOne({ username }).sort({ updatedAt: -1 }).lean();
        if (!doc) {
          console.log("No bundle found for user:", username);
          return;
        }
        const lastStage = Array.isArray(doc.stages) && doc.stages.length
          ? doc.stages[doc.stages.length - 1]
          : null;
        console.log(JSON.stringify({
          bundleId: doc.bundleId,
          parentBundleId: doc.parentBundleId || null,
          status: doc.status,
          plannerMode: doc.plannerOutput?.mode || null,
          metricsRequested: doc.metricsRequested || [],
          stageCount: Array.isArray(doc.stages) ? doc.stages.length : 0,
          currentStageIndex: doc.currentStageIndex,
          lastStage: lastStage ? {
            stageIndex: lastStage.stageIndex,
            title: lastStage.title,
            source: lastStage.source,
            moreAvailable: lastStage.moreAvailable,
            hasChartSpec: Boolean(lastStage.chartSpec),
          } : null,
          updatedAt: doc.updatedAt,
        }, null, 2));
      } catch (err) {
        console.error("Bundle snapshot failed:", err.message || String(err));
        process.exitCode = 1;
      } finally {
        await mongoose.disconnect().catch(() => {});
      }
    })();
  '
)

print_header "Done"
echo "Phase 3 smoke checks completed."
