#!/usr/bin/env bash
# 在 st2-aii 的 kind 集群里验证 loom 告警规则：
#   1) promtool 校验规则语法；
#   2) 部署可选的最小 Prometheus（deploy/monitoring/prometheus.yaml），确认抓到所有 loom Pod、规则全部加载且无求值错误；
#   3) 规则引用的每个指标都能查到真实序列；
#   4) 制造一次异常（无效 Key 请求），确认 LoomDenyRatioHigh 的表达式对真实数据求值超过阈值。
# 用法：deploy/monitoring/check.sh [--host HOST] [--keep]（--keep 保留 Prometheus，默认验证后删除）
set -euo pipefail
cd "$(dirname "$0")"
HOST="${DEPLOY_HOST:-192.168.16.62}"
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift ;;
    --keep) KEEP=1 ;;
  esac
  shift
done
REMOTE_DIR=/opt/agentgateway/loom/monitoring
ssh "${HOST}" "mkdir -p ${REMOTE_DIR}"
scp -q loom-alerts.yaml prometheus.yaml "${HOST}:${REMOTE_DIR}/"

ssh "${HOST}" "KEEP=${KEEP} REMOTE_DIR=${REMOTE_DIR} bash -s" <<'REMOTE'
set -euo pipefail
export PATH=/opt/agentgateway/k8s/bin:$PATH
IMAGE=prom/prometheus:v2.53.0
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS\t%s\t%s\n' "$1" "$2"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL\t%s\t%s\n' "$1" "$2"; }
check() { if [ "$2" = "$3" ]; then ok "$1" "$3"; else bad "$1" "expected $2 got $3"; fi; }

echo "### 1. promtool check rules"
out=$(docker run --rm --entrypoint promtool -v "$REMOTE_DIR:/rules:ro" "$IMAGE" check rules /rules/loom-alerts.yaml 2>&1 || true)
check "promtool check rules" SUCCESS "$(echo "$out" | grep -o 'SUCCESS' | head -1)"

echo "### 2. 部署最小 Prometheus"
# kind load 对带多平台清单的镜像会因 --all-platforms 找不到 digest 而失败，这里直接按当前平台导入每个节点
for node in $(kind get nodes --name agentgateway); do
  docker save "$IMAGE" | docker exec -i "$node" ctr --namespace=k8s.io images import --snapshotter=overlayfs - >/dev/null
done
kubectl -n loom create configmap loom-alert-rules --from-file=loom-alerts.yaml="$REMOTE_DIR/loom-alerts.yaml" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -f "$REMOTE_DIR/prometheus.yaml" >/dev/null
kubectl -n loom rollout restart deploy/loom-prometheus >/dev/null
kubectl -n loom rollout status deploy/loom-prometheus --timeout=120s >/dev/null
api() { kubectl -n loom exec deploy/loom-prometheus -- wget -qO- "http://127.0.0.1:9090/api/v1/$1"; }
query() { api "query?query=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1")"; }
sleep 35 # 至少两轮抓取与规则求值

loom_pods=$(kubectl -n loom get pods -l app=loom --no-headers | wc -l | tr -d ' ')
check "scrapes every loom pod" "$loom_pods" "$(query 'sum(up{job="loom"})' | python3 -c 'import json,sys; r=json.load(sys.stdin)["data"]["result"]; print(int(float(r[0]["value"][1])) if r else 0)')"

rules=$(api rules | python3 -c '
import json,sys
groups=json.load(sys.stdin)["data"]["groups"]
rules=[r for g in groups for r in g["rules"]]
bad=[r["name"]+": "+r.get("lastError","") for r in rules if r.get("health")!="ok"]
print(len(rules), "|", "; ".join(bad) or "none")')
check "alert rules loaded" 12 "$(echo "$rules" | cut -d'|' -f1 | tr -d ' ')"
check "rules evaluated without errors" none "$(echo "$rules" | cut -d'|' -f2 | sed 's/^ //')"

echo "### 3. 规则引用的指标都有真实序列"
# loom_store_errors_total{op}、loom_ledger_cost_mismatch_total{model} 的标签取值是动态的，首次出错前不存在，不在此检查
for metric in loom_admission_decisions_total loom_admission_duration_seconds_bucket \
  loom_store_pool_acquired_conns loom_store_pool_max_conns loom_ledger_settle_errors_total \
  loom_ledger_reservations_expired_total loom_otlp_dropped_total loom_pricing_reloads_total \
  loom_cache_sync_reconnects_total; do
  n=$(query "count({__name__=\"$metric\"})" | python3 -c 'import json,sys; r=json.load(sys.stdin)["data"]["result"]; print("yes" if r else "no")')
  check "series exist: $metric" yes "$n"
done

echo "### 4. 制造拒绝，验证 LoomDenyRatioHigh 的表达式"
for i in $(seq 1 300); do
  curl -s -o /dev/null -H 'Authorization: Bearer loom-invalid-key-for-alert-check' \
    -H 'content-type: application/json' -d '{"model":"lab-model"}' http://127.0.0.1:14001/v1/chat/completions
done
sleep 35
expr='sum(rate(loom_admission_decisions_total{allowed="false"}[10m])) / sum(rate(loom_admission_decisions_total[10m])) > 0.2'
check "deny ratio expression fires on real data" yes "$(query "$expr" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)["data"]["result"] else "no")')"
check "LoomDown expression quiet while healthy" no "$(query 'sum(up{job="loom"}) < 1 or absent(up{job="loom"})' | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)["data"]["result"] else "no")')"
state=$(api alerts | python3 -c 'import json,sys; print(",".join(sorted({a["labels"]["alertname"]+"="+a["state"] for a in json.load(sys.stdin)["data"]["alerts"]})) or "none")')
printf 'INFO\tactive alerts\t%s\n' "$state"
check "LoomDenyRatioHigh is pending (for: 10m)" yes "$(echo "$state" | grep -q 'LoomDenyRatioHigh=pending' && echo yes || echo no)"

if [ "$KEEP" -eq 0 ]; then
  kubectl delete -f "$REMOTE_DIR/prometheus.yaml" >/dev/null
  kubectl -n loom delete configmap loom-alert-rules >/dev/null
fi
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
REMOTE
