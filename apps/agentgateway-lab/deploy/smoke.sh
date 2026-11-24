#!/usr/bin/env bash
# Smoke test for the extAuth + telemetry lab. Run on the lab host (<lab-host-ip>).
#   BASE=http://127.0.0.1:14001 ./deploy/smoke.sh
set -uo pipefail

BASE=${BASE:-http://127.0.0.1:14001}
PASS=0
FAIL=0

check() { # name expect actual
  if [ "$3" = "$2" ]; then printf '  ok   %-34s %s\n' "$1" "$3"; PASS=$((PASS+1));
  else printf '  FAIL %-34s want=%s got=%s\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}

code() { curl -s -o /tmp/smoke.body -w '%{http_code}' "$@"; }

echo "== extAuth matrix ($BASE)"
check "no credential"        401 "$(code $BASE/echo)"
check "alice api key"        200 "$(code -H 'x-api-key: sk-lab-alice' $BASE/echo)"
check "bob budget exhausted" 429 "$(code -H 'x-api-key: sk-lab-bob' $BASE/echo)"
check "carol inactive"       403 "$(code -H 'x-api-key: sk-lab-carol' $BASE/echo)"
check "bogus key"            401 "$(code -H 'x-api-key: sk-bogus' $BASE/echo)"
check "grpc ext_authz route" 200 "$(code -H 'x-api-key: sk-lab-alice' $BASE/grpc)"
check "grpc route bad key"   401 "$(code -H 'x-api-key: sk-bogus' $BASE/grpc)"

echo "== identity injection"
curl -s -H 'x-api-key: sk-lab-alice' "$BASE/echo?verbose=1" > /tmp/smoke.verbose
for h in X-Client-Id X-Tenant-Id X-Plan X-Auth-Source X-Budget-Remaining-Cents; do
  if grep -q "\"$h\"" /tmp/smoke.verbose; then printf '  ok   header %s\n' "$h"; PASS=$((PASS+1));
  else printf '  FAIL header %s missing\n' "$h"; FAIL=$((FAIL+1)); fi
done

echo "== billing pipeline"
curl -s -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -H 'x-api-key: sk-lab-alice' \
  -d '{"model":"lab-model","messages":[{"role":"user","content":"smoke test billing"}]}' >/dev/null
sleep 3
ROWS=$(kubectl -n agentgateway-demo exec deploy/lab-postgres -- psql -U agw -d agw_lab -t -A -c \
  "select count(*) from usage_events where client_id='alice' and realized_cost_micros>0")
check "usage_events with realized cost" 1 "$([ "$ROWS" -ge 1 ] && echo 1 || echo 0)"

TRACES=$(kubectl -n agentgateway-demo exec deploy/finops -- wget -qO- http://127.0.0.1:9100/v1/traces/summary \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["spans"])')
check "traces ingested" 1 "$([ "$TRACES" -ge 1 ] && echo 1 || echo 0)"

SUMMARY=$(kubectl -n agentgateway-demo exec deploy/finops -- wget -qO- \
  'http://127.0.0.1:9100/v1/usage/summary?client=alice')
echo "$SUMMARY" | grep -q '"client_id": "alice"' && { echo '  ok   chargeback summary'; PASS=$((PASS+1)); } \
  || { echo '  FAIL chargeback summary'; FAIL=$((FAIL+1)); }

echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
