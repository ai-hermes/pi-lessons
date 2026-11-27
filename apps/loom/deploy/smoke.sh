#!/usr/bin/env bash
# 在 st2-aii 宿主机上执行 loom 验收矩阵（通过 ssh 把脚本送到远端运行，curl 打 127.0.0.1:14001，DB 断言用 kubectl exec psql）。
# 用法：deploy/smoke.sh [--host HOST] [--skip-failclosed] [--skip-reload]
set -euo pipefail
HOST="${DEPLOY_HOST:-192.168.16.62}"
SKIP_FAILCLOSED=0; SKIP_RELOAD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift ;;
    --skip-failclosed) SKIP_FAILCLOSED=1 ;;
    --skip-reload) SKIP_RELOAD=1 ;;
  esac
  shift
done
ssh "${HOST}" "SKIP_FAILCLOSED=${SKIP_FAILCLOSED} SKIP_RELOAD=${SKIP_RELOAD} bash -s" <<'REMOTE'
set -u
export PATH=/opt/agentgateway/k8s/bin:$PATH
BASE=http://127.0.0.1:14001
ADMIN_TOKEN=loom-admin-token-change-me
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'PASS\t%s\t%s\n' "$1" "$2"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL\t%s\t%s\n' "$1" "$2"; }
check() { # name expected actual
  if [ "$2" = "$3" ]; then ok "$1" "$3"; else bad "$1" "expected $2 got $3"; fi
}
code()   { curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$@"; }
reason() { curl -s -D - -o /dev/null --max-time 30 "$@" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-loom-deny-reason"{print $2}'; }
q()      { kubectl -n loom exec deploy/loom-postgres -- psql -U loom -d loom -Atc "$1"; }
admin()  { kubectl -n loom exec deploy/loom -- wget -qO- --header="Authorization: Bearer $ADMIN_TOKEN" "http://127.0.0.1:9090$1"; }
chat()   { curl -s --max-time 60 -H "Authorization: Bearer $1" -H 'content-type: application/json' -d "{\"model\":\"$2\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" "$BASE$3"; }
key() { case "$1" in
  alice) echo loom-demo-alice-0000000000000001;; bob) echo loom-demo-bob-000000000000000002;;
  carol) echo loom-demo-carol-000000000000000003;; dave) echo loom-demo-dave-000000000000000004;;
  dave-images) echo loom-demo-dave-images-only-0005;; erin) echo loom-demo-erin-000000000000000006;;
  vera) echo loom-demo-vera-000000000000000007;; frank) echo loom-demo-frank-000000000000000008;; esac; }
admin_post() { kubectl -n loom exec deploy/loom -- wget -qO- --header="Authorization: Bearer $ADMIN_TOKEN" --header='Content-Type: application/json' --post-data="$2" "http://127.0.0.1:9090$1"; }
wait_ready() { kubectl -n loom rollout status deploy/loom --timeout=120s >/dev/null; for i in $(seq 1 30); do [ "$(code $BASE/echo -H 'x-api-key: $(key dave)')" = 200 ] && break; sleep 2; done; }
# reset <account> <key-name> <limit>：把账户与 Key 的额度上限/已用量复位，保证矩阵可重复执行
reset() {
  aid=$(admin /v1/accounts | python3 -c "import json,sys; print(next(a['id'] for a in json.load(sys.stdin)['accounts'] if a['name']=='$1'))")
  kid=$(admin "/v1/accounts/$aid/keys" | python3 -c "import json,sys; print(next(k['id'] for k in json.load(sys.stdin)['keys'] if k['name']=='$2'))")
  admin_post "/v1/accounts/$aid/quota" "{\"quota_limit_nanos\":$3,\"quota_used_nanos\":0}" >/dev/null
  admin_post "/v1/keys/$kid/quota" "{\"quota_limit_nanos\":$3,\"quota_used_nanos\":0}" >/dev/null
}
wait_ready
reset alice default 5000000
reset erin default 15360000

echo "### 1. 鉴权拒绝矩阵"
check "no credential → 401" 401 "$(code -X POST -H 'content-type: application/json' -d '{"model":"lab-model"}' $BASE/v1/chat/completions)"
check "no credential reason" missing_credential "$(reason -X POST -H 'content-type: application/json' -d '{"model":"lab-model"}' $BASE/v1/chat/completions)"
check "unknown key → 401" 401 "$(code -X POST -H 'x-api-key: loom-nope' -H 'content-type: application/json' -d '{"model":"lab-model"}' $BASE/v1/chat/completions)"
check "unknown key reason" unknown_api_key "$(reason -X POST -H 'x-api-key: loom-nope' -H 'content-type: application/json' -d '{"model":"lab-model"}' $BASE/v1/chat/completions)"
check "carol disabled → 403" 403 "$(code -X POST -H "x-api-key: $(key carol)" -H 'content-type: application/json' -d '{"model":"lab-model"}' $BASE/v1/chat/completions)"
check "carol reason" client_inactive "$(reason -X POST -H "x-api-key: $(key carol)" -H 'content-type: application/json' -d '{"model":"lab-model"}' $BASE/v1/chat/completions)"
check "frank expired → 401" 401 "$(code -X POST -H "x-api-key: $(key frank)" -H 'content-type: application/json' -d '{"model":"lab-model"}' $BASE/v1/chat/completions)"
check "frank reason" expired_api_key "$(reason -X POST -H "x-api-key: $(key frank)" -H 'content-type: application/json' -d '{"model":"lab-model"}' $BASE/v1/chat/completions)"
check "bob account quota → 403" 403 "$(code -X POST -H "x-api-key: $(key bob)" -H 'content-type: application/json' -d '{"model":"lab-model"}' $BASE/v1/chat/completions)"
check "bob reason" insufficient_quota "$(reason -X POST -H "x-api-key: $(key bob)" -H 'content-type: application/json' -d '{"model":"lab-model"}' $BASE/v1/chat/completions)"
check "dave unpriced model → 403" 403 "$(code -X POST -H "x-api-key: $(key dave)" -H 'content-type: application/json' -d '{"model":"no-such-model"}' $BASE/v1/chat/completions)"
check "unpriced reason" model_not_priced "$(reason -X POST -H "x-api-key: $(key dave)" -H 'content-type: application/json' -d '{"model":"no-such-model"}' $BASE/v1/chat/completions)"
check "images-only key on lab-model → 403" 403 "$(code -X POST -H "x-api-key: $(key dave-images)" -H 'content-type: application/json' -d '{"model":"lab-model"}' $BASE/v1/chat/completions)"
check "allowlist reason" model_not_allowed "$(reason -X POST -H "x-api-key: $(key dave-images)" -H 'content-type: application/json' -d '{"model":"lab-model"}' $BASE/v1/chat/completions)"

echo "### 2. 按量计费：alice 额度 5,000,000，预扣 3,072,000 → 两次 200 后 403"
BEFORE=$(q "select count(*) from usage_events where model='lab-model'")
check "alice #1 → 200" 200 "$(code -X POST -H "x-api-key: $(key alice)" -H 'content-type: application/json' -d '{"model":"lab-model","messages":[{"role":"user","content":"hi"}]}' $BASE/v1/chat/completions)"
sleep 4   # 等待 #1 的预扣经遥测结算（flush 2s），否则 #2 会因预扣未释放被拒
RESP=$(chat "$(key alice)" lab-model /v1/chat/completions)
check "alice #2 → 200 + usage" "1000/500/200" "$(echo "$RESP" | sed -n 's/.*"prompt_tokens":\([0-9]*\).*"completion_tokens":\([0-9]*\).*"cached_tokens":\([0-9]*\).*/\1\/\2\/\3/p')"
check "alice #3 → 403" 403 "$(code -X POST -H "x-api-key: $(key alice)" -H 'content-type: application/json' -d '{"model":"lab-model","messages":[{"role":"user","content":"hi"}]}' $BASE/v1/chat/completions)"
check "alice #3 reason" insufficient_quota "$(reason -X POST -H "x-api-key: $(key alice)" -H 'content-type: application/json' -d '{"model":"lab-model","messages":[{"role":"user","content":"hi"}]}' $BASE/v1/chat/completions)"
sleep 4
check "alice key quota_used = 2 × 1,820,000" 3640000 "$(q "select quota_used from api_keys where name='default' and account_id=(select id from accounts where name='alice')")"
check "alice key reserved back to 0" 0 "$(q "select reserved from api_keys where name='default' and account_id=(select id from accounts where name='alice')")"
check "alice account quota_used" 3640000 "$(q "select quota_used from accounts where name='alice'")"
check "usage_events.cost_nanos (loom)" 1820000 "$(q "select cost_nanos from usage_events where model='lab-model' and account_id=(select id from accounts where name='alice') order by id desc limit 1")"
check "usage_events.gateway_cost_nanos (对账)" 1820000 "$(q "select gateway_cost_nanos from usage_events where model='lab-model' and account_id=(select id from accounts where name='alice') order by id desc limit 1")"
check "usage_events tokens" "1000|500|200" "$(q "select input_tokens||'|'||output_tokens||'|'||cached_tokens from usage_events where model='lab-model' and account_id=(select id from accounts where name='alice') order by id desc limit 1")"
check "usage_events.pricing_source" configmap "$(q "select pricing_source from usage_events where model='lab-model' and account_id=(select id from accounts where name='alice') order by id desc limit 1")"
check "reservations settled (0 left for alice)" 0 "$(q "select count(*) from reservations where account_id=(select id from accounts where name='alice')")"

echo "### 3. 分组倍率：vera(vip 0.9) → 1,638,000"
chat "$(key vera)" lab-model /v1/chat/completions >/dev/null
sleep 4
check "vera cost_nanos = 1,638,000" 1638000 "$(q "select cost_nanos from usage_events where account_id=(select id from accounts where name='vera') order by id desc limit 1")"
check "vera gateway cost = 1,820,000 (catalog 1 倍价，对账时 × 0.9)" 1820000 "$(q "select gateway_cost_nanos from usage_events where account_id=(select id from accounts where name='vera') order by id desc limit 1")"
check "vera pricing snapshot = vip|0.9" "vip|0.9" "$(q "select pricing_group || '|' || group_ratio from usage_events where account_id=(select id from accounts where name='vera') order by id desc limit 1")"

echo "### 4. 按次计费：图片模型 lab-image = \$0.04"
check "dave images-only key lab-image → 200" 200 "$(code -X POST -H "x-api-key: $(key dave-images)" -H 'content-type: application/json' -d '{"model":"lab-image","prompt":"cat"}' $BASE/v1/images/generations)"
sleep 4
check "lab-image cost_nanos = 40,000,000" 40000000 "$(q "select cost_nanos from usage_events where model='lab-image' order by id desc limit 1")"
check "lab-image attributed to dave" "$(q "select name from accounts where name='dave'")" "$(q "select a.name from usage_events u join accounts a on a.id=u.account_id where u.model='lab-image' order by u.id desc limit 1")"

echo "### 5. PG 兜底定价：lab-pg-only 只在 model_pricing 表"
check "dave lab-pg-only → 200" 200 "$(code -X POST -H "x-api-key: $(key dave)" -H 'content-type: application/json' -d '{"model":"lab-pg-only","messages":[{"role":"user","content":"hi"}]}' $BASE/pg/v1/chat/completions)"
sleep 4
check "lab-pg-only pricing_source = pg" pg "$(q "select pricing_source from usage_events where model='lab-pg-only' order by id desc limit 1")"
check "lab-pg-only cost = 1000×500+... ratio 0.25 → 800×500+200×50+500×1000 = 910,000" 910000 "$(q "select cost_nanos from usage_events where model='lab-pg-only' order by id desc limit 1")"

echo "### 6. embeddings 路由"
check "dave embeddings → 200" 200 "$(code -X POST -H "x-api-key: $(key dave)" -H 'content-type: application/json' -d '{"model":"lab-model","input":["a"]}' $BASE/v1/embeddings)"
check "dave images → 200" 200 "$(code -X POST -H "x-api-key: $(key dave)" -H 'content-type: application/json' -d '{"model":"lab-image","prompt":"cat"}' $BASE/v1/images/generations)"

echo "### 7. 并发预扣：erin 额度 15,360,000 = 5 × 3,072,000；并发 20 次不得超额（RLS 同步结算会让早完成的请求释放预扣，故 200 次数 ≥ 5）"
cat > /tmp/loom-req.sh <<'REQ'
curl -s -o /dev/null -w '%{http_code}\n' --max-time 60 -X POST -H 'x-api-key: loom-demo-erin-000000000000000006' -H 'content-type: application/json' -d '{"model":"lab-model","messages":[{"role":"user","content":"hi"}]}' http://127.0.0.1:14001/v1/chat/completions
REQ
RESULT=$(seq 1 20 | xargs -P 20 -I{} sh /tmp/loom-req.sh | sort | uniq -c | awk '{print $2"="$1}' | tr '\n' ' ')
OK_COUNT=$(echo "$RESULT" | tr ' ' '\n' | awk -F= '$1==200{print $2}')
check "erin concurrent → 200 ≥ 5 and 200 + 403 = 20" "yes" "$([ "${OK_COUNT:-0}" -ge 5 ] && [ "$RESULT" = "200=$OK_COUNT 403=$((20-OK_COUNT)) " ] && echo yes || echo "no: $RESULT")"
sleep 4
check "erin reserved back to 0" 0 "$(q "select reserved from api_keys where account_id=(select id from accounts where name='erin')")"
check "erin quota_used ≤ quota_limit (从不超额)" yes "$(q "select case when quota_used <= quota_limit then 'yes' else 'no: '||quota_used end from api_keys where account_id=(select id from accounts where name='erin')")"
check "erin charged = 200 次数 × 1,820,000" "$((OK_COUNT*1820000))" "$(q "select quota_used from api_keys where account_id=(select id from accounts where name='erin')")"

echo "### 8. 凭据头清理与 identity 注入（/echo 回显上游收到的请求头）"
check "echo GET no credential → 401" 401 "$(code $BASE/echo)"
check "echo POST no credential → 401" 401 "$(code -X POST $BASE/echo)"
E=$(curl -s -H "Authorization: Bearer $(key dave)" -H "x-api-key: $(key dave)" $BASE/echo)
check "upstream has no authorization" "" "$(echo "$E" | sed -n 's/.*"authorization":\("[^"]*"\).*/\1/p')"
check "upstream has no x-api-key" "" "$(echo "$E" | sed -n 's/.*"x-api-key":\("[^"]*"\).*/\1/p')"
check "upstream has x-loom-client-id=dave" dave "$(echo "$E" | sed -n 's/.*"x-loom-client-id":"\([^"]*\)".*/\1/p')"
check "upstream has x-loom-request-id (uuid)" uuid "$(echo "$E" | sed -n 's/.*"x-loom-request-id":"\([0-9a-f-]\{36\}\)".*/\1/p' | sed 's/[0-9a-f-]//g; s/^$/uuid/')"

echo "### 9. gRPC ext_authz 门面（/grpc）"
check "grpc route no credential → 401" 401 "$(code $BASE/grpc)"
check "grpc route dave → 200" 200 "$(code -H "x-api-key: $(key dave)" $BASE/grpc)"
check "grpc route bogus → 401" 401 "$(code -H 'x-api-key: loom-bogus' $BASE/grpc)"

echo "### 10. 管理 API 与指标"
check "admin rejects undefined group" "HTTP/1.1 400" "$(admin_post /v1/accounts '{"name":"smoke-ghost","group":"no-such-group"}' 2>&1 | grep -o 'HTTP/1.1 400' | head -1)"
check "admin list accounts includes the 7 demo accounts" 7 "$(admin /v1/accounts | python3 -c 'import json,sys; names={a["name"] for a in json.load(sys.stdin)["accounts"]}; print(len(names & {"alice","bob","carol","dave","erin","vera","frank"}))')"
check "admin usage summary has rows" yes "$(admin '/v1/usage/summary' | grep -q '"total"' && echo yes)"
check "admin pricing view has pg row" 1 "$(admin /v1/pricing | grep -o '"model":"lab-pg-only"' | wc -l | tr -d ' ')"
check "admin catalog has lab-model rate 1" '"input":"1"' "$(admin /v1/catalog | grep -o '"input":"1"' | head -1)"
M=$(kubectl -n loom exec deploy/loom -- wget -qO- http://127.0.0.1:9090/metrics)
for mname in loom_admission_decisions_total loom_admission_duration_seconds loom_pricing_lookups_total loom_ledger_reserved_nanos_total loom_ledger_settled_nanos_total loom_ledger_remaining_nanos loom_ledger_reservations_open loom_ledger_reservations_expired_total loom_ledger_settlements_total loom_otlp_queue_depth loom_ratelimit_calls_total loom_store_pool_acquires_total loom_build_info; do
  check "metric $mname" yes "$(echo "$M" | grep -q "^$mname" && echo yes)"
done
# 带标签的 counter 在首次自增前不会出现：只要求没有 mismatch 计数（下一行）
check "no cost mismatch between loom and gateway" "" "$(echo "$M" | grep '^loom_ledger_cost_mismatch_total' | grep -v ' 0$' | sed 's/^/MISMATCH: /')"
check "auth audit rows > 0" yes "$(q "select case when count(*)>0 then 'yes' end from auth_audit")"

if [ "$SKIP_RELOAD" = 0 ]; then
echo "### 11. ConfigMap 热加载：lab-image 价格 0.04 → 0.05，30s 内生效，无需重启"
  kubectl -n loom get configmap loom-pricing -o jsonpath='{.data.pricing\.yaml}' | sed 's/lab-image:  {model_price: 0.04}/lab-image:  {model_price: 0.05}/' > /tmp/pricing.yaml
  grep -q 'model_price: 0.05' /tmp/pricing.yaml
  kubectl -n loom create configmap loom-pricing --from-file=pricing.yaml=/tmp/pricing.yaml --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  # kubelet 同步 ConfigMap 卷（最长 ~1min）+ loom 30s 轮询：逐个副本轮询管理 API，直到所有副本都看到新价
  all_pods_new_price() {
    for pod in $(kubectl -n loom get pods -l app=loom -o name); do
      kubectl -n loom exec "$pod" -- wget -qO- --header="Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:9090/v1/pricing 2>/dev/null | grep -q '"model_price":0.05' || return 1
    done
    return 0
  }
  for i in $(seq 1 36); do all_pods_new_price && break; sleep 5; done
  check "hot reload visible on every replica via admin API within 180s" yes "$(all_pods_new_price && echo yes)"
  curl -s -o /dev/null -X POST -H "x-api-key: $(key dave)" -H 'content-type: application/json' -d '{"model":"lab-image","prompt":"cat"}' $BASE/v1/images/generations
  sleep 4
  check "lab-image after reload = 50,000,000" 50000000 "$(q "select cost_nanos from usage_events where model='lab-image' order by id desc limit 1")"
  kubectl -n loom create configmap loom-pricing --from-file=pricing.yaml=/opt/agentgateway/loom/configs/pricing.yaml --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  RELOADS=$(kubectl -n loom exec deploy/loom -- wget -qO- http://127.0.0.1:9090/metrics | awk -F' ' '/^loom_pricing_reloads_total\{result="ok"\}/{s+=$2} END{print int(s)}')
  check "pricing reload counter ≥ 2" yes "$([ "${RELOADS:-0}" -ge 2 ] && echo yes || echo no:$RELOADS)"
fi

echo "### 13. RLS 同步结算通道：响应完成后网关 amend → loom data 端口，先于 OTLP 入库"
dave_rows() { q "select count(*) from usage_events where model='lab-model' and account_id=(select id from accounts where name='dave')"; }
BEFORE=$(dave_rows)
curl -s -o /dev/null -m 60 -X POST -H "x-api-key: $(key dave)" -H 'content-type: application/json' -d '{"model":"lab-model","messages":[{"role":"user","content":"hi"}]}' $BASE/v1/chat/completions
sleep 1   # 不等 OTLP 的 2s flush：RLS 是同步的，1s 内应已入库
check "non-stream settled by rls within 1s" $((BEFORE+1)) "$(dave_rows)"
STREAM_USAGE=$(curl -s -N -m 60 -X POST -H "x-api-key: $(key dave)" -H 'content-type: application/json' -d '{"model":"lab-model","stream":true,"messages":[{"role":"user","content":"hi"}]}' $BASE/v1/chat/completions | grep -o '"prompt_tokens":[0-9]*' | head -1 | cut -d: -f2)
check "stream response carries usage" 1000 "$STREAM_USAGE"
sleep 1
check "stream settled by rls within 1s" $((BEFORE+2)) "$(dave_rows)"
M2=$(for pod in $(kubectl -n loom get pods -l app=loom -o name); do kubectl -n loom exec "$pod" -- wget -qO- http://127.0.0.1:9090/metrics 2>/dev/null; done)
check "rls amend calls observed" yes "$(echo "$M2" | grep -q '^loom_ratelimit_calls_total{phase="amend"}' && echo yes)"
check "rls channel inserted rows" yes "$(echo "$M2" | grep -E '^loom_ledger_settlements_total\{channel="rls",inserted="true"\} [1-9]' | grep -q . && echo yes)"
check "otlp duplicates blocked by idempotency key" yes "$(echo "$M2" | grep -E '^loom_ledger_settlements_total\{channel="otlp",inserted="false"\} [1-9]' | grep -q . && echo yes)"
echo "### 14. 单通道独立性：移除 OTLP access log 策略，仅靠 RLS 也能结算；恢复后两通道并存"
kubectl -n loom delete agentgatewaypolicy gateway-access-log >/dev/null; sleep 3
BEFORE=$(dave_rows)
curl -s -o /dev/null -m 60 -X POST -H "x-api-key: $(key dave)" -H 'content-type: application/json' -d '{"model":"lab-model","messages":[{"role":"user","content":"hi"}]}' $BASE/v1/chat/completions
sleep 1
check "with otlp policy removed, rls alone settles" $((BEFORE+1)) "$(dave_rows)"
kubectl -n loom apply -f /opt/agentgateway/loom/k8s/09-telemetry.yaml >/dev/null
for i in $(seq 1 15); do [ "$(kubectl -n loom get agentgatewaypolicy gateway-access-log -o jsonpath='{.status.ancestors[0].conditions[?(@.type=="Accepted")].status}')" = True ] && break; sleep 2; done
check "access log policy restored" True "$(kubectl -n loom get agentgatewaypolicy gateway-access-log -o jsonpath='{.status.ancestors[0].conditions[?(@.type=="Accepted")].status}')"
sleep 3
curl -s -o /dev/null -m 60 -X POST -H "x-api-key: $(key dave)" -H 'content-type: application/json' -d '{"model":"lab-model","messages":[{"role":"user","content":"hi"}]}' $BASE/v1/chat/completions
sleep 4
check "both channels: otlp backfills gateway cost on rls-settled row" 1820000 "$(q "select gateway_cost_nanos from usage_events where model='lab-model' and account_id=(select id from accounts where name='dave') order by id desc limit 1")"

if [ "$SKIP_FAILCLOSED" = 0 ]; then
echo "### 15. 多副本缓存失效：只在一个副本上停用 Key，所有副本立即拒绝（不等缓存 TTL）"
SYNC_KEY=loom-cache-sync-000000000000001
printf 'accounts:\n  - name: cache-sync\n    keys:\n      - name: default\n        plaintext: %s\n' "$SYNC_KEY" \
  | kubectl -n loom exec -i deploy/loom -- loom seed --config /etc/loom/config.yaml --file /dev/stdin >/dev/null
sleep 1 # seed 也会广播失效消息，等它送达后再取指标基线
SYNC_AID=$(admin /v1/accounts | python3 -c "import json,sys; print(next(a['id'] for a in json.load(sys.stdin)['accounts'] if a['name']=='cache-sync'))")
SYNC_KID=$(admin "/v1/accounts/$SYNC_AID/keys" | python3 -c "import json,sys; print(json.load(sys.stdin)['keys'][0]['id'])")
# invalidations <origin>：所有副本上 kind=api_key、指定 origin 的失效次数之和
invalidations() {
  for pod in $(kubectl -n loom get pods -l app=loom -o name); do
    kubectl -n loom exec "$pod" -- wget -qO- http://127.0.0.1:9090/metrics 2>/dev/null
  done | awk -v o="$1" '$1 ~ "^loom_cache_invalidations_total\\{" && $1 ~ "kind=\"api_key\"" && $1 ~ "origin=\""o"\"" {s+=$2} END {printf "%d", s}'
}
# patch_key_on <pod> <status>：经 port-forward 只在指定副本上调用管理 API
patch_key_on() {
  kubectl -n loom port-forward "$1" 19090:9090 >/dev/null 2>&1 & local pf=$!
  sleep 2
  curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H 'Content-Type: application/json' -d "{\"status\":\"$2\"}" "http://127.0.0.1:19090/v1/keys/$SYNC_KID"
  kill "$pf" 2>/dev/null; wait "$pf" 2>/dev/null
}
REPLICAS=$(kubectl -n loom get pods -l app=loom --no-headers | wc -l | tr -d ' ')
POD_A=$(kubectl -n loom get pods -l app=loom -o name | head -1)
for i in 1 2 3 4; do code -H "x-api-key: $SYNC_KEY" $BASE/echo >/dev/null; done   # 让 Key 进入缓存
LOCAL0=$(invalidations local); REMOTE0=$(invalidations remote)
check "disable key via one replica" 200 "$(patch_key_on "$POD_A" disabled)"
DENIED=0
for i in $(seq 1 10); do [ "$(code -H "x-api-key: $SYNC_KEY" $BASE/echo)" = 403 ] && DENIED=$((DENIED+1)); done
check "all 10 immediate requests denied on every replica" 10 "$DENIED"
check "publisher replica invalidated locally once" 1 $(( $(invalidations local) - LOCAL0 ))
check "other replicas invalidated remotely" $((REPLICAS - 1)) $(( $(invalidations remote) - REMOTE0 ))
check "re-enable key" 200 "$(patch_key_on "$POD_A" active)"
check "re-enabled key accepted immediately" 200 "$(code -H "x-api-key: $SYNC_KEY" $BASE/echo)"

echo "### 16. 管理面：分角色 token、即时吊销、额度变更流水、操作审计、pprof 默认关闭"
kubectl -n loom port-forward deploy/loom 19091:9090 >/dev/null 2>&1 & OPS_PF=$!
sleep 2
OPS=http://127.0.0.1:19091
# ops <token> <method> <path> [json]：返回 "<http_code> <body>"
ops() {
  curl -s -w ' %{http_code}' -X "$2" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' \
    ${4:+-d "$4"} "$OPS$3"
}
status_of() { echo "${1##* }"; }
SUFFIX=$(date +%s)
issue() { # issue <name> <role> → "<id> <plaintext>"
  ops "$ADMIN_TOKEN" POST /v1/admin/tokens "{\"name\":\"$1-$SUFFIX\",\"role\":\"$2\"}" \
    | sed 's/ [0-9]*$//' | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["token"]["id"], d["plaintext"])'
}
read -r READER_ID READER <<<"$(issue smoke-reader read)"
read -r WRITER_ID WRITER <<<"$(issue smoke-writer write)"
check "read token can list accounts" 200 "$(status_of "$(ops "$READER" GET /v1/accounts)")"
check "read token cannot write" 403 "$(status_of "$(ops "$READER" POST /v1/accounts '{"name":"x"}')")"
check "revoke read token" 204 "$(status_of "$(ops "$ADMIN_TOKEN" DELETE "/v1/admin/tokens/$READER_ID")")"
check "revoked token rejected immediately" 401 "$(status_of "$(ops "$READER" GET /v1/accounts)")"
LIMIT_BEFORE=$(q "select coalesce(quota_limit, 0) from accounts where name='cache-sync'")
check "top up with write token" 200 "$(status_of "$(ops "$WRITER" POST "/v1/accounts/$SYNC_AID/topup" '{"nanos":7}')")"
check "quota ledger records actor and before/after" "top_up|smoke-writer-$SUFFIX|$((LIMIT_BEFORE + 7))" \
  "$(q "select kind || '|' || actor || '|' || limit_after from quota_adjustments where account_id='$SYNC_AID' order by id desc limit 1")"
check "admin audit records the top-up" "smoke-writer-$SUFFIX|/v1/accounts/:id/topup|200" \
  "$(q "select actor || '|' || route || '|' || status from admin_audit order by id desc limit 1")"
check "smoke resets are in the quota ledger" yes \
  "$(q "select count(*) from quota_adjustments a join accounts c on c.id = a.account_id where c.name = 'alice' and a.kind = 'reset' and a.actor = 'bootstrap'" | awk '{print ($1 > 0) ? "yes" : "no"}')"
check "pprof is off by default" 404 "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ADMIN_TOKEN" "$OPS/debug/pprof/")"
ops "$ADMIN_TOKEN" DELETE "/v1/admin/tokens/$WRITER_ID" >/dev/null
kill "$OPS_PF" 2>/dev/null; wait "$OPS_PF" 2>/dev/null

echo "### 17. 超时预算：PG 行锁时准入在自己的截止时间（1.5s）内拒绝，预扣整体回滚"
# 第 16 节的充值让 cache-sync 有了上限；复位为不限额并清空预扣，保证请求真的走到被锁的行
admin_post "/v1/accounts/$SYNC_AID/quota" '{"quota_limit_nanos":null,"quota_used_nanos":0}' >/dev/null
admin_post "/v1/keys/$SYNC_KID/quota" '{"quota_limit_nanos":null,"quota_used_nanos":0}' >/dev/null
kubectl -n loom exec deploy/loom-postgres -- psql -U loom -d loom -qc \
  "BEGIN; SELECT 1 FROM accounts WHERE name = 'cache-sync' FOR UPDATE; SELECT pg_sleep(6); COMMIT;" >/dev/null 2>&1 &
LOCK=$!
sleep 1.5
OUT=$(curl -s -o /dev/null -D - -w 'time=%{time_total}\n' --max-time 30 -H "x-api-key: $SYNC_KEY" -H 'content-type: application/json' \
  -d '{"model":"lab-model","messages":[{"role":"user","content":"hi"}]}' "$BASE/v1/chat/completions" | tr -d '\r')
check "locked account row → 500" 500 "$(echo "$OUT" | awk 'NR==1{print $2}')"
check "deny reason internal_error" internal_error "$(echo "$OUT" | awk -F': ' 'tolower($1)=="x-loom-deny-reason"{print $2}')"
check "answered before the gateway's 2s extAuth timeout" yes "$(echo "$OUT" | sed -n 's/^time=//p' | awk '{print ($1 < 2.0) ? "yes" : "no"}')"
wait "$LOCK"
check "no reservation leaked after the timeout" "0|0|0" "$(q "select k.reserved || '|' || a.reserved || '|' || (select count(*) from reservations r where r.account_id = a.id) from accounts a join api_keys k on k.account_id = a.id where a.name = 'cache-sync'")"
check "requests succeed once the lock is gone" 200 "$(code -H "x-api-key: $SYNC_KEY" -H 'content-type: application/json' -d '{"model":"lab-model","messages":[{"role":"user","content":"hi"}]}' $BASE/v1/chat/completions)"

echo "### 18. FailClosed：loom 副本缩到 0 → 拒绝；恢复 → 放行"
  kubectl -n loom scale deploy/loom --replicas=0 >/dev/null
  sleep 8
  C=$(code -H "x-api-key: $(key dave)" $BASE/echo)
  case "$C" in 403|503) ok "fail closed while loom is down" "$C";; *) bad "fail closed while loom is down" "expected 403/503 got $C";; esac
  kubectl -n loom scale deploy/loom --replicas=2 >/dev/null
  wait_ready
  check "recovered → 200" 200 "$(code -H "x-api-key: $(key dave)" $BASE/echo)"
fi

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
REMOTE
