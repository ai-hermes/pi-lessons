#!/usr/bin/env bash
# loom 压测基线：经网关打 lab-model（mock 上游即时返回），按并发分档记录
#   - 端到端吞吐与延迟（loom-bench，客户端视角，含网关 + loom + mock）
#   - loom 准入耗时分位数（loom_admission_duration_seconds{stage="total"}，所有 Pod 汇总）
#   - 每请求的 PG 事务数与行写入数（pg_stat_database 增量）
# 单账户（一个 Key，测账户行热点）与多账户（每个请求轮询 N 个 Key）各跑一组。
# 用法：deploy/bench.sh [--host HOST] [--accounts 16] [--duration 15s] [--levels "1 8 32 64"] [--groups "single multi"]
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${DEPLOY_HOST:-192.168.16.62}"
ACCOUNTS=16
DURATION=15s
LEVELS="1 8 32 64"
GROUPS_TO_RUN="single multi"
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift ;;
    --accounts) ACCOUNTS="$2"; shift ;;
    --duration) DURATION="$2"; shift ;;
    --levels) LEVELS="$2"; shift ;;
    --groups) GROUPS_TO_RUN="$2"; shift ;;
  esac
  shift
done

BENCH_BIN="$(mktemp -d)/loom-bench"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "$BENCH_BIN" ./cmd/loom-bench
scp -q "$BENCH_BIN" "${HOST}:/opt/agentgateway/loom/loom-bench"

cat "$(dirname "$0")/pg.sh" - <<'REMOTE' | ssh "${HOST}" "ACCOUNTS=${ACCOUNTS} DURATION=${DURATION} LEVELS='${LEVELS}' GROUPS_TO_RUN='${GROUPS_TO_RUN}' bash -s"
set -euo pipefail
export PATH=/opt/agentgateway/k8s/bin:$PATH
BENCH=/opt/agentgateway/loom/loom-bench

bench_key() { printf 'loom-bench-%02d-000000000000000000\n' "$1"; }

echo "==> seed ${ACCOUNTS} bench accounts (unlimited quota, default group)"
{
  echo "accounts:"
  for i in $(seq 1 "$ACCOUNTS"); do
    printf '  - name: bench-%02d\n    keys:\n      - name: default\n        plaintext: %s\n' "$i" "$(bench_key "$i")"
  done
} | kubectl -n loom exec -i deploy/loom -- loom seed --config /etc/loom/config.yaml --file /dev/stdin | tail -1

pg_stats() { q "select xact_commit, tup_inserted + tup_updated + tup_deleted from pg_stat_database where datname='loom'"; }
metrics() {
  for pod in $(kubectl -n loom get pods -l app=loom -o name); do
    kubectl -n loom exec "$pod" -- wget -qO- http://127.0.0.1:9090/metrics 2>/dev/null
  done | grep -E '^loom_admission_duration_seconds_(bucket|count)\{.*stage="total"|^loom_otlp_dropped_total '
}
# admission_quantiles <before-file> <after-file>：由直方图增量估算 p50 / p99（毫秒，取桶上界）
admission_quantiles() {
  python3 - "$1" "$2" <<'PY'
import re, sys, collections
def load(path):
    buckets, dropped = collections.Counter(), 0.0
    for line in open(path):
        name, value = line.rsplit(" ", 1)
        if name.startswith("loom_otlp_dropped_total"):
            dropped += float(value)
            continue
        m = re.search(r'le="([^"]+)"', name)
        if m:
            buckets[float("inf") if m.group(1) == "+Inf" else float(m.group(1))] += float(value)
    return buckets, dropped
(b0, d0), (b1, d1) = load(sys.argv[1]), load(sys.argv[2])
cum = sorted((le, b1[le] - b0[le]) for le in b1)
total = cum[-1][1] if cum else 0
def q(p):
    for le, n in cum:
        if total and n >= p * total:
            return "inf" if le == float("inf") else f"{le * 1000:g}"
    return "-"
print(f"admission_ms<= p50={q(0.50)} p99={q(0.99)} admissions={int(total)} otlp_dropped+={int(d1 - d0)}")
PY
}

run_level() { # <label> <concurrency> <keys>
  local label=$1 c=$2 keys=$3 before after
  read -r tx0 rows0 <<<"$(pg_stats | tr '|' ' ')"
  metrics >/tmp/loom-bench-m0
  out=$("$BENCH" -keys "$keys" -c "$c" -d "$DURATION")
  sleep 3 # 等 OTLP 补账落库，计入本档的 PG 写入
  read -r tx1 rows1 <<<"$(pg_stats | tr '|' ' ')"
  metrics >/tmp/loom-bench-m1
  requests=$(echo "$out" | sed -n 's/.*requests=\([0-9]*\).*/\1/p')
  echo "--- ${label} c=${c}"
  echo "$out"
  admission_quantiles /tmp/loom-bench-m0 /tmp/loom-bench-m1
  python3 -c "r=max($requests,1); print(f'pg per request: transactions={($tx1-$tx0)/r:.1f} rows_written={($rows1-$rows0)/r:.1f}')"
}

single=$(bench_key 1)
multi=$(for i in $(seq 1 "$ACCOUNTS"); do bench_key "$i"; done | paste -sd, -)

echo "==> warm up"
"$BENCH" -keys "$multi" -c 8 -d 5s >/dev/null

if [[ " $GROUPS_TO_RUN " == *" single "* ]]; then
  echo "==> single account (one key, account row hotspot)"
  for c in $LEVELS; do run_level "single-account" "$c" "$single"; done
fi
if [[ " $GROUPS_TO_RUN " == *" multi "* ]]; then
  echo "==> ${ACCOUNTS} accounts (round-robin keys)"
  for c in $LEVELS; do run_level "multi-account" "$c" "$multi"; done
fi
REMOTE
