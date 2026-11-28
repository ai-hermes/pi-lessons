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

echo "### 2. 上游报错：token 用量为 0，completion 描述符让 RLS 立即结算；status 为 4xx/5xx，不计费并释放预扣"
observe "upstream 503"        503 rls 0 false -H 'x-mock-status: 503'
observe "upstream 400"        400 rls 0 false -H 'x-mock-status: 400'
observe "stream upstream 503" 503 rls 0 true  -H 'x-mock-status: 503'

# set_tokenize <true|false>：开关 lab-chat 的 tokenize（需要支持该字段的网关；不支持时返回非 0）
set_tokenize() {
  kubectl -n loom patch agentgatewaybackend lab-chat --type json \
    -p "[{\"op\":\"add\",\"path\":\"/spec/ai/groups/0/providers/0/tokenize\",\"value\":$1}]" >/dev/null 2>&1 && sleep 5
}
TOKENIZE_SUPPORTED=0
kubectl explain agentgatewaybackend.spec.ai.groups.providers.tokenize >/dev/null 2>&1 && TOKENIZE_SUPPORTED=1
[ "$TOKENIZE_SUPPORTED" = 1 ] && set_tokenize false

echo "### 3. 客户端在带 usage 的结束 chunk 之前断开：网关拿不到用量，RLS 带回状态 200，按预扣估值结算"
# curl 因 --max-time 主动断开时返回码记为 200（响应头已收到）；lab-model 预扣估值 1024×1,000 + 1024×2,000 = 3,072,000
observe "stream client abort" 200 rls 3072000 true  -H 'x-mock-stream-chunks: 10' -H 'x-mock-stream-delay-ms: 200' --max-time 0.5
check "stream client abort: billed at the reserve estimate" reserve_estimate \
  "$(q "select billing_basis from usage_events where account_id=$DAVE order by id desc limit 1")"

echo "### 4. 同上，但 provider 开启 tokenize：网关按请求与已转发内容计数补上用量，按估算的 token 计价"
if [ "$TOKENIZE_SUPPORTED" = 1 ]; then
  set_tokenize true
  before_events=$(events)
  check "tokenize abort: http status" 200 "$(request true -H 'x-mock-stream-chunks: 10' -H 'x-mock-stream-delay-ms: 200' --max-time 0.5)"
  sleep 3
  check "tokenize abort: exactly one usage event" 1 "$(( $(events) - before_events ))"
  check "tokenize abort: reservation released" 0 "$(reservations)"
  EST=$(q "select billing_basis || '|' || cost_nanos || '|' || input_tokens || '|' || output_tokens from usage_events where account_id=$DAVE order by id desc limit 1")
  check "tokenize abort: billed by the gateway estimate" gateway_estimate "$(echo "$EST" | cut -d'|' -f1)"
  check "tokenize abort: input and output were counted" yes \
    "$(echo "$EST" | awk -F'|' '{print ($3 > 0 && $4 > 0) ? "yes" : "no"}')"
  check "tokenize abort: cheaper than the reserve estimate" yes \
    "$(echo "$EST" | awk -F'|' '{print ($2 > 0 && $2 < 3072000) ? "yes" : "no"}')"
  printf 'INFO\testimate\t%s\n' "$EST"
  set_tokenize false
else
  printf 'INFO\ttokenize\tskipped: the gateway CRD has no tokenize field (needs a gateway with stream usage estimation)\n'
fi

q "delete from reservations where account_id=$DAVE" >/dev/null
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
REMOTE
