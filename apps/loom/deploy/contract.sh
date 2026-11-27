#!/usr/bin/env bash
# AgentGateway 契约测试：观察网关在各种情况下如何上报用量、loom 如何结算与释放预扣。
# 在 st2-aii 宿主机上执行（ssh 送到远端），请求打 127.0.0.1:14001，DB 断言用 kubectl exec psql。
# 用法：deploy/contract.sh [--host HOST]
set -euo pipefail
HOST="${DEPLOY_HOST:-192.168.16.62}"
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift ;;
  esac
  shift
done
cat "$(dirname "$0")/pg.sh" - <<'REMOTE' | ssh "${HOST}" 'bash -s'
set -u
export PATH=/opt/agentgateway/k8s/bin:$PATH
BASE=http://127.0.0.1:14001
KEY=loom-demo-dave-000000000000000004
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS\t%s\t%s\n' "$1" "$2"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL\t%s\t%s\n' "$1" "$2"; }
check() { if [ "$2" = "$3" ]; then ok "$1" "$3"; else bad "$1" "expected $2 got $3"; fi; }
DAVE="(select id from accounts where name='dave')"
events()       { q "select count(*) from usage_events where account_id=$DAVE"; }
last_event()   { q "select cost_nanos || '|' || input_tokens || '|' || output_tokens from usage_events where account_id=$DAVE order by id desc limit 1"; }
reservations() { q "select count(*) from reservations where account_id=$DAVE"; }
# settled <channel>：所有 loom Pod 上 inserted=true 的结算次数之和（哪个通道先完成结算）
settled() {
  for pod in $(kubectl -n loom get pods -l app=loom -o name); do
    kubectl -n loom exec "$pod" -- wget -qO- http://127.0.0.1:9090/metrics 2>/dev/null
  done | awk -v ch="$1" '$1 ~ "^loom_ledger_settlements_total\\{" && $1 ~ "channel=\""ch"\"" && $1 ~ "inserted=\"true\"" {s+=$2} END {printf "%d", s}'
}

# request <name> <stream:true|false> [curl args...]：发一次 lab-model 请求，返回 HTTP 状态码
request() {
  local stream=$1; shift
  curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d "{\"model\":\"lab-model\",\"stream\":$stream,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
    "$@" "$BASE/v1/chat/completions"
}

# observe <name> <http> <settled_by:rls|otlp> <cost> <stream> [curl args...]
# 每个场景都断言：返回码、恰好一条用量记录、金额、3 秒后预扣已释放、由哪个通道完成结算。
observe() {
  local name=$1 want_http=$2 want_channel=$3 want_cost=$4; shift 4
  local before_events before_resv before_rls before_otlp status
  before_events=$(events); before_resv=$(reservations)
  before_rls=$(settled rls); before_otlp=$(settled otlp)
  status=$(request "$@")
  sleep 3
  local d_events=$(( $(events) - before_events ))
  local resv=$(( $(reservations) - before_resv ))
  local d_rls=$(( $(settled rls) - before_rls )) d_otlp=$(( $(settled otlp) - before_otlp ))
  local channel=none
  [ "$d_rls" -gt 0 ] && channel=rls
  [ "$d_otlp" -gt 0 ] && channel=otlp
  [ "$d_rls" -gt 0 ] && [ "$d_otlp" -gt 0 ] && channel=both
  printf 'INFO\t%s\thttp=%s events+%s reservations_open+%s settled_by=%s last=%s\n' \
    "$name" "$status" "$d_events" "$resv" "$channel" "$(last_event)"
  check "$name: http status" "$want_http" "$status"
  check "$name: exactly one usage event" 1 "$d_events"
  check "$name: settled cost" "$want_cost" "$(last_event | cut -d'|' -f1)"
  check "$name: reservation released within 3s" 0 "$resv"
  check "$name: settled by" "$want_channel" "$channel"
}

kubectl -n loom rollout status deploy/loom --timeout=120s >/dev/null
# 清掉 dave 历史遗留的预扣，避免影响计数（只影响演示账户）
q "delete from reservations where account_id=$DAVE" >/dev/null

echo "### 1. 正常响应：RLS 同步结算，OTLP 只补写网关金额"
observe "non-stream 200"      200 rls 1820000 false
observe "stream 200"          200 rls 1820000 true

echo "### 2. 上游报错：token 用量为 0，completion 描述符让 RLS 立即结算为 0 并释放预扣"
observe "upstream 503"        503 rls 0 false -H 'x-mock-status: 503'
observe "upstream 400"        400 rls 0 false -H 'x-mock-status: 400'
observe "stream upstream 503" 503 rls 0 true  -H 'x-mock-status: 503'

echo "### 3. 客户端在带 usage 的结束 chunk 之前断开：网关拿不到用量，由 RLS 按 0 结算（已知计费缺口）"
# curl 因 --max-time 主动断开时返回码记为 200（响应头已收到）
observe "stream client abort" 200 rls 0 true  -H 'x-mock-stream-chunks: 10' -H 'x-mock-stream-delay-ms: 200' --max-time 0.5

q "delete from reservations where account_id=$DAVE" >/dev/null
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
REMOTE
