#!/usr/bin/env bash
# 真实上游验证：经 loom-gateway 调用火山方舟按量付费接口，逐场景对比“客户端收到的 usage”与“loom 落库的结算”。
# 前置：st2-aii 上已部署 loom，并已应用 deploy/real/ark.yaml、写入 Secret loom/ark-upstream-key（见 deploy/real/README.md）。
# 会产生少量真实费用（每轮约几十次请求、数千 token）。
# 用法：deploy/real/run.sh [--host HOST] [--model 方舟模型 ID] [--deepseek 方舟模型 ID]
set -euo pipefail
HOST="${DEPLOY_HOST:-192.168.16.62}"
MODEL=doubao-seed-2-0-lite-260428
DEEPSEEK=deepseek-v4-flash-ga-260731
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift ;;
    --model) MODEL="$2"; shift ;;
    --deepseek) DEEPSEEK="$2"; shift ;;
    *) echo "unknown arg $1" >&2; exit 1 ;;
  esac
  shift
done

cat "$(dirname "$0")/../pg.sh" - <<'REMOTE' | ssh "$HOST" "MODEL=$MODEL DEEPSEEK=$DEEPSEEK bash -s"
set -u
export PATH=/opt/agentgateway/k8s/bin:$PATH
URL=http://127.0.0.1:14001/ark/v1/chat/completions
ADMIN_TOKEN=loom-admin-token-change-me
KEY=loom-real-upstream-0000000000001
PASS=0; FAIL=0; NOTE=0
ok()    { PASS=$((PASS+1)); printf 'PASS\t%s\t%s\n' "$1" "$2"; }
bad()   { FAIL=$((FAIL+1)); printf 'FAIL\t%s\t%s\n' "$1" "$2"; }
note()  { NOTE=$((NOTE+1)); printf 'NOTE\t%s\t%s\n' "$1" "$2"; }
check() { if [ "$2" = "$3" ]; then ok "$1" "$3"; else bad "$1" "expected $2 got $3"; fi; }
admin_post() { kubectl -n loom exec deploy/loom -- wget -qO- --header="Authorization: Bearer $ADMIN_TOKEN" --header='Content-Type: application/json' --post-data="$2" "http://127.0.0.1:9090$1"; }

# seed_key <rate_limits>：专用测试账户（额度 0.1 USD，用于观察扣减）
seed_key() {
  printf 'accounts:\n  - name: real-upstream\n    quota_limit_nanos: 100000000\n    keys:\n      - name: default\n        plaintext: %s\n        rate_limits: %s\n' "$KEY" "$1" \
    | kubectl -n loom exec -i deploy/loom -- loom seed --config /etc/loom/config.yaml --file /dev/stdin >/dev/null
  sleep 1
}
seed_key '{}'
AID=$(q "select id from accounts where name = 'real-upstream'")
KID=$(q "select id from api_keys where account_id = '$AID'")
admin_post "/v1/accounts/$AID/quota" '{"quota_limit_nanos":100000000,"quota_used_nanos":0}' >/dev/null
admin_post "/v1/keys/$KID/quota" '{"quota_limit_nanos":null,"quota_used_nanos":0}' >/dev/null
T0=$(date +%s)

# call <name> <json-body> [curl args...]：结果写到 /tmp/real-<name>.{out,hdr}，打印 HTTP 状态码
call() {
  local name=$1 body=$2; shift 2
  curl -s -o "/tmp/real-$name.out" -D "/tmp/real-$name.hdr" -w '%{http_code}' --max-time 120 "$@" \
    -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d "$body" "$URL"
}
# client_usage <name>：客户端视角的 usage（非流式取 usage，流式取最后一个带 usage 的 chunk），输出 input|cached|output
client_usage() {
  python3 - "/tmp/real-$1.out" <<'PY'
import json, sys
raw = open(sys.argv[1], encoding="utf-8", errors="replace").read()
usage = None
if raw.lstrip().startswith("{"):
    usage = json.loads(raw).get("usage")
else:
    for line in raw.splitlines():
        if line.startswith("data:") and "usage" in line:
            try:
                chunk = json.loads(line[5:])
            except ValueError:
                continue
            usage = chunk.get("usage") or usage
if not usage:
    print("none")
else:
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
    print(f'{usage["prompt_tokens"]}|{cached}|{usage["completion_tokens"]}')
PY
}
# loom_event <since-epoch>：该账户在 since 之后最新一条结算，输出 input|cached|output|cost|gateway_cost|source
loom_event() {
  local row=""
  for _ in $(seq 1 20); do
    row=$(q "select input_tokens||'|'||cached_tokens||'|'||output_tokens||'|'||cost_nanos||'|'||coalesce(gateway_cost_nanos::text,'-')
             from usage_events where account_id = '$AID' and time >= to_timestamp($1) order by time desc limit 1")
    [ -n "$row" ] && break
    sleep 0.5
  done
  echo "$row"
}
tokens_of() { echo "$1" | cut -d'|' -f1-3; }
# reconciled <since-epoch>：等 OTLP 补写网关金额后返回 loom 金额|网关金额（RLS 先结算，补写晚约 0.5s）
reconciled() {
  local row=""
  for _ in $(seq 1 20); do
    row=$(q "select cost_nanos||'|'||coalesce(gateway_cost_nanos::text,'-')
             from usage_events where account_id = '$AID' and time >= to_timestamp($1) order by time desc limit 1")
    case "$row" in *'|-'|'') sleep 0.5 ;; *) break ;; esac
  done
  echo "$row"
}
same_cost() { local r; r=$(reconciled "$1"); [ "${r%%|*}" = "${r##*|}" ] && echo "equal ($r)" || echo "differ ($r)"; }
reserved() { q "select reserved || '|' || in_flight from accounts where id = '$AID'"; }
open_reservations() { q "select count(*) from reservations where account_id = '$AID'"; }
chat_body() { # model max_tokens prompt [extra-json-fields]
  printf '{"model":"%s","max_tokens":%s,"messages":[{"role":"user","content":"%s"}]%s}' "$1" "$2" "$3" "${4:-}"
}

echo "### 1. 非流式（思考模型）：客户端 usage 与 loom 结算逐项一致，loom 金额与网关 catalog 金额一致"
T=$(date +%s)
check "http" 200 "$(call nonstream "$(chat_body "$MODEL" 60 '用一句话介绍杭州。')")"
CU=$(client_usage nonstream); EV=$(loom_event "$T")
check "tokens input|cached|output" "$CU" "$(tokens_of "$EV")"
check "loom cost = gateway cost" equal "$(same_cost "$T" | cut -d' ' -f1)"
note "reasoning tokens counted as output" "$(python3 -c 'import json; u=json.load(open("/tmp/real-nonstream.out"))["usage"]; print(u["completion_tokens"], "of which reasoning", (u.get("completion_tokens_details") or {}).get("reasoning_tokens"), "; max_tokens=60")')"
check "reservation released" "0|0" "$(reserved)"

echo "### 2. 关闭思考（thinking.disabled）：参数经网关透传"
T=$(date +%s)
check "http" 200 "$(call nothink "$(chat_body "$MODEL" 60 '用一句话介绍杭州。' ',"thinking":{"type":"disabled"}')")"
CU=$(client_usage nothink); EV=$(loom_event "$T")
check "tokens input|cached|output" "$CU" "$(tokens_of "$EV")"
note "output tokens without thinking" "$(echo "$CU" | cut -d'|' -f3)"

echo "### 3. 流式，客户端未要求 usage（无 stream_options）"
T=$(date +%s)
check "http" 200 "$(call stream-plain "$(chat_body "$MODEL" 40 '数到五。' ',"stream":true,"thinking":{"type":"disabled"}')")"
CU=$(client_usage stream-plain); EV=$(loom_event "$T")
note "client sees usage although it did not ask (gateway adds include_usage upstream)" "$CU"
check "loom still settles real tokens (gateway asks upstream for usage)" yes "$([ "$(echo "$EV" | cut -d'|' -f3)" -gt 0 ] && echo yes || echo no)"

echo "### 4. 流式，stream_options.include_usage=true"
T=$(date +%s)
check "http" 200 "$(call stream-usage "$(chat_body "$MODEL" 40 '数到五。' ',"stream":true,"stream_options":{"include_usage":true},"thinking":{"type":"disabled"}')")"
CU=$(client_usage stream-usage); EV=$(loom_event "$T")
check "tokens input|cached|output" "$CU" "$(tokens_of "$EV")"
check "loom cost = gateway cost" equal "$(same_cost "$T" | cut -d' ' -f1)"

echo "### 5. 上游报错（非法参数 → 方舟 400）：不计费，预扣立即释放"
T=$(date +%s)
CODE=$(call upstream-400 "$(chat_body "$MODEL" 20 'hi' ',"temperature":9')")
check "http from upstream" 400 "$CODE"
note "upstream error body" "$(head -c 200 /tmp/real-upstream-400.out)"
EV=$(loom_event "$T")
check "settled with zero tokens and cost" "0|0|0|0" "$(echo "$EV" | cut -d'|' -f1-4)"
check "reservation released" "0|0" "$(reserved)"

echo "### 6. 客户端中途断开（流式生成中 2s 断开）"
T=$(date +%s)
call abort "$(chat_body "$MODEL" 2000 '写一篇一千字的散文，主题是秋天。' ',"stream":true,"stream_options":{"include_usage":true},"thinking":{"type":"disabled"}')" --max-time 2 >/dev/null || true
CHUNKS=$(grep -c '^data:' /tmp/real-abort.out || true)
note "chunks received before abort" "$CHUNKS"
EV=$(loom_event "$T")
note "loom settlement for the aborted stream (input|cached|output|cost); gateway saw status 200 but no usage" "$(echo "$EV" | cut -d'|' -f1-4)"
# 预扣估值：1024 × 输入单价 + 1024 × 输出单价（loom 记录准入时的预扣额，结算按同一估值）
check "aborted stream billed at the reserve estimate" reserve_estimate \
  "$(q "select billing_basis from usage_events where account_id = '$AID' and time >= to_timestamp($T) order by time desc limit 1")"
check "estimate equals the admission hold" "$(kubectl -n loom logs -l app=loom --since=2m --max-log-requests=4 \
  | grep '"admission allowed"' | grep real-upstream | tail -1 | sed -E 's/.*"reserved_nanos":([0-9]+).*/\1/')" \
  "$(echo "$EV" | cut -d'|' -f4)"
sleep 2
check "reservation released after abort" "0|0" "$(reserved)"
check "no open reservations" 0 "$(open_reservations)"

echo "### 7. DeepSeek（非流式）"
T=$(date +%s)
check "http" 200 "$(call deepseek "$(chat_body "$DEEPSEEK" 60 '用一句话介绍杭州。')")"
CU=$(client_usage deepseek); EV=$(loom_event "$T")
check "tokens input|cached|output" "$CU" "$(tokens_of "$EV")"
check "loom cost = gateway cost" equal "$(same_cost "$T" | cut -d' ' -f1)"

echo "### 8. 前缀缓存：同一长前缀连发两次，观察 cached_tokens"
LONG=$(python3 -c 'print("请记住以下资料。" + "杭州是浙江省省会，西湖是著名景点。" * 120)')
for i in 1 2; do
  T=$(date +%s)
  call cache-$i "$(chat_body "$MODEL" 20 "$LONG 问：西湖在哪个城市？" ',"thinking":{"type":"disabled"}')" >/dev/null
  CU=$(client_usage cache-$i); EV=$(loom_event "$T")
  check "cache round $i tokens input|cached|output" "$CU" "$(tokens_of "$EV")"
done
note "cached tokens on the second round" "$(client_usage cache-2 | cut -d'|' -f2)"

echo "### 9. TPM 按真实用量修正：上限 3000、每次估值 2048，实际远小于估值时可连续放行"
seed_key '{tpm: 3000}'
sleep 2 # 等待计数窗口与缓存失效
CODES=""
for i in 1 2 3; do
  CODES="$CODES $(call tpm-$i "$(chat_body "$MODEL" 20 '只回答：好' ',"thinking":{"type":"disabled"}')")"
  sleep 1
done
note "status codes (2048 + actual corrections)" "$CODES"
check "first two pass thanks to the correction" "200 200" "$(echo "$CODES" | awk '{print $1, $2}')"
seed_key '{}'

echo "### 10. 账户额度扣减与本轮结算总额一致"
check "accounts.quota_used = sum(usage_events.cost_nanos) of this run" \
  "$(q "select coalesce(sum(cost_nanos), 0) from usage_events where account_id = '$AID' and time >= to_timestamp($T0)")" \
  "$(q "select quota_used from accounts where id = '$AID'")"

echo "RESULT: PASS=$PASS FAIL=$FAIL NOTE=$NOTE"
REMOTE
