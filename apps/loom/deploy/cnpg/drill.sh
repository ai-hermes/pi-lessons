#!/usr/bin/env bash
# CloudNativePG 演练（需 deploy/deploy.sh --pg cnpg 部署后执行）：
#   failover    持续请求中强制删除主库 Pod（模拟节点宕机），度量错误窗口与切换耗时，校验账本一致性
#   switchover  同上，但正常删除主库 Pod（模拟滚动升级、节点排空：主库主动释放租约）
#   restore   按需基础备份 → 写入时间点前后两个标记 → 按时间点恢复到独立集群 loom-pg-restore → 只应看到前一个标记
# 用法：deploy/cnpg/drill.sh [--host HOST] [failover] [switchover] [restore]（默认 failover restore）
set -euo pipefail
HOST="${DEPLOY_HOST:-192.168.16.62}"
DRILLS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift ;;
    failover | switchover | restore) DRILLS="$DRILLS $1" ;;
    *) echo "unknown arg $1" >&2; exit 1 ;;
  esac
  shift
done
DRILLS="${DRILLS:-failover restore}"

cat "$(dirname "$0")/../pg.sh" - <<'REMOTE' | ssh "$HOST" "DRILLS='${DRILLS}' bash -s"
set -u
export PATH=/opt/agentgateway/k8s/bin:$PATH
BASE=http://127.0.0.1:14001
PASS=0; FAIL=0
ok()    { PASS=$((PASS+1)); printf 'PASS\t%s\t%s\n' "$1" "$2"; }
bad()   { FAIL=$((FAIL+1)); printf 'FAIL\t%s\t%s\n' "$1" "$2"; }
check() { if [ "$2" = "$3" ]; then ok "$1" "$3"; else bad "$1" "expected $2 got $3"; fi; }
now_ms() { date +%s%3N; }
primary() { kubectl -n loom get cluster loom-pg -o jsonpath='{.status.currentPrimary}'; }
seed_account() { # name key
  printf 'accounts:\n  - name: %s\n    keys:\n      - name: default\n        plaintext: %s\n' "$1" "$2" \
    | kubectl -n loom exec -i deploy/loom -- loom seed --config /etc/loom/config.yaml --file /dev/stdin >/dev/null
}

compensations() { # 两个 loom 副本上补偿释放计数之和
  local result=$1 total=0 n
  for pod in $(kubectl -n loom get pods -l app=loom -o name); do
    n=$(kubectl -n loom exec "$pod" -- wget -qO- http://127.0.0.1:9090/metrics \
      | awk -v r="$result" '$1 == "loom_ledger_reserve_compensations_total{result=\""r"\"}" {print int($2)}')
    total=$((total + ${n:-0}))
  done
  echo "$total"
}

drill_failover()   { primary_loss failover --grace-period=0 --force; }
drill_switchover() { primary_loss switchover; }

primary_loss() { # name kubectl-delete-flags...
  local name=$1; shift
  echo "### $name：4 路并发持续请求 40s，第 10s 删除主库 Pod（kubectl delete pod $*）"
  local stamp; stamp=$(date +%H%M%S)
  local account="drill-$name-$stamp" key="loom-drill-$name-$stamp-0000000000" log="/tmp/loom-drill-$name.log"
  seed_account "$account" "$key"
  local aid; aid=$(q "select id from accounts where name = '$account'")
  local released_before; released_before=$(compensations released)
  local old; old=$(primary)
  : > "$log"
  local end=$(( $(date +%s) + 40 ))
  for _ in 1 2 3 4; do
    (
      while [ "$(date +%s)" -lt "$end" ]; do
        out=$(curl -s -o /dev/null -D - -w 'code=%{http_code}\n' --max-time 10 -H "x-api-key: $key" \
          -H 'content-type: application/json' \
          -d '{"model":"lab-model","messages":[{"role":"user","content":"hi"}]}' "$BASE/v1/chat/completions" \
          | tr -d '\r' | awk -F': ' 'tolower($1)=="x-loom-deny-reason"{r=$2} /^code=/{c=substr($0,6)} END{print c, (r?r:"-")}')
        echo "$(now_ms) $out" >> "$log"
      done
    ) &
  done
  sleep 10
  local killed_at; killed_at=$(now_ms)
  kubectl -n loom delete pod "$old" "$@" >/dev/null 2>&1
  local new="$old"
  while [ "$new" = "$old" ] || [ -z "$new" ]; do sleep 0.5; new=$(primary); done
  local promoted_at; promoted_at=$(now_ms)
  wait
  kubectl -n loom wait --for=condition=Ready cluster/loom-pg --timeout=300s >/dev/null
  local healthy_at; healthy_at=$(now_ms)

  local total ok200 failed first_fail last_fail
  total=$(wc -l < "$log")
  ok200=$(awk '$2==200' "$log" | wc -l)
  failed=$(awk '$2!=200' "$log" | wc -l)
  first_fail=$(awk '$2!=200{print $1; exit}' "$log")
  last_fail=$(awk '$2!=200{t=$1} END{print t}' "$log")
  echo "primary $old → $new; promoted after $(( promoted_at - killed_at )) ms, cluster healthy after $(( healthy_at - killed_at )) ms"
  echo "requests total=$total ok=$ok200 failed=$failed"
  awk '$2!=200{print "  ", $2, $3}' "$log" | sort | uniq -c
  if [ "$failed" -gt 0 ]; then echo "error window $(( last_fail - first_fail )) ms (first failure $(( first_fail - killed_at )) ms after the kill)"; fi
  [ "$new" != "$old" ] && ok "a replica was promoted" "$new" || bad "a replica was promoted" "$new"
  [ $(( promoted_at - killed_at )) -lt 60000 ] && ok "promotion within 60s" "$(( promoted_at - killed_at )) ms" \
    || bad "promotion within 60s" "$(( promoted_at - killed_at )) ms"
  check "requests succeed after failover" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "x-api-key: $key" \
    -H 'content-type: application/json' -d '{"model":"lab-model","messages":[{"role":"user","content":"hi"}]}' \
    "$BASE/v1/chat/completions")"

  echo "等待结算（RLS 主通道 + OTLP 补账）与补偿释放（≤30s）完成……"
  sleep 35
  echo "reservations released by compensation: $(( $(compensations released) - released_before ))"
  local events used_sum settled_sum reserved held
  events=$(q "select count(*) from usage_events where account_id = '$aid'")
  used_sum=$(q "select quota_used from accounts where id = '$aid'")
  settled_sum=$(q "select coalesce(sum(cost_nanos), 0) from usage_events where account_id = '$aid' and settled")
  reserved=$(q "select reserved from accounts where id = '$aid'")
  held=$(q "select coalesce(sum(nanos), 0) from reservations where account_id = '$aid'")
  echo "usage_events=$events (client saw $(( ok200 + 1 )) × 200) quota_used=$used_sum reserved=$reserved held_by_reservations=$held"
  check "every successful request has exactly one usage event" "$(( ok200 + 1 ))" "$events"
  check "quota_used equals the sum of settled usage" "$settled_sum" "$used_sum"
  check "reserved equals the open reservations" "$held" "$reserved"
  check "no reservation left open" 0 "$(q "select count(*) from reservations where account_id = '$aid'")"
}

drill_restore() {
  echo "### restore：按需备份 → 标记 before → 记录目标时间 → 标记 after → 时间点恢复"
  local stamp; stamp=$(date +%H%M%S)
  local backup=loom-pg-drill-$stamp
  cat <<EOF | kubectl apply -f - >/dev/null
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: $backup
  namespace: loom
spec:
  cluster: {name: loom-pg}
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
EOF
  local start; start=$(now_ms)
  until [ "$(kubectl -n loom get backup "$backup" -o jsonpath='{.status.phase}')" = completed ]; do
    phase=$(kubectl -n loom get backup "$backup" -o jsonpath='{.status.phase}')
    [ "$phase" = failed ] && { bad "base backup" "failed"; return; }
    sleep 2
  done
  ok "base backup completed" "$(( $(now_ms) - start )) ms"

  seed_account "drill-before-$stamp" "loom-drill-before-$stamp-000000000"
  sleep 2
  local target; target=$(q "select to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")
  sleep 2
  seed_account "drill-after-$stamp" "loom-drill-after-$stamp-0000000000"
  # 让包含 after 的 WAL 段立即归档（pg_switch_wal 需要超级用户，经本地套接字以 postgres 身份执行）
  kubectl -n loom exec "$(primary)" -c postgres -- psql -U postgres -Atc "select pg_switch_wal()" >/dev/null
  local accounts_at_target; accounts_at_target=$(q "select count(*) from accounts where created_at <= '$target'")
  echo "recovery target $target (accounts at target: $accounts_at_target)"
  sleep 10

  kubectl -n loom delete cluster loom-pg-restore --ignore-not-found --wait=true >/dev/null
  start=$(now_ms)
  cat <<EOF | kubectl apply -f - >/dev/null
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: loom-pg-restore
  namespace: loom
spec:
  instances: 1
  imageName: $(kubectl -n loom get cluster loom-pg -o jsonpath='{.spec.imageName}')
  storage: {size: 5Gi}
  bootstrap:
    recovery:
      source: origin
      recoveryTarget:
        targetTime: "$target"
  externalClusters:
  - name: origin
    plugin:
      name: barman-cloud.cloudnative-pg.io
      parameters:
        barmanObjectName: loom-pg-backups
        serverName: loom-pg
EOF
  if ! kubectl -n loom wait --for=condition=Ready cluster/loom-pg-restore --timeout=600s >/dev/null; then
    bad "point-in-time restore" "cluster not ready"
    kubectl -n loom get pods -l cnpg.io/cluster=loom-pg-restore
    return
  fi
  ok "point-in-time restore ready" "$(( $(now_ms) - start )) ms"
  rq() { kubectl -n loom exec loom-pg-restore-1 -c postgres -- psql -U postgres -d loom -Atc "$1"; }
  check "restored cluster has the account written before the target" 1 \
    "$(rq "select count(*) from accounts where name = 'drill-before-$stamp'")"
  check "restored cluster lacks the account written after the target" 0 \
    "$(rq "select count(*) from accounts where name = 'drill-after-$stamp'")"
  check "restored account count equals the source at the target time" "$accounts_at_target" \
    "$(rq "select count(*) from accounts")"
  kubectl -n loom delete cluster loom-pg-restore --wait=false >/dev/null
  kubectl -n loom delete backup "$backup" >/dev/null
}

for d in $DRILLS; do "drill_$d"; done
echo "RESULT: PASS=$PASS FAIL=$FAIL"
REMOTE
