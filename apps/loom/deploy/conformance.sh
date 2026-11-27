#!/usr/bin/env bash
# 在 st2-aii 的真实 PostgreSQL 上运行 store 一致性用例（internal/store/storetest）。
# 每次重建独立数据库 loom_conformance，不触碰 loom 库；经 ssh 隧道 + kubectl port-forward 访问，在本地执行 go test。
# 用法：deploy/conformance.sh [--host HOST]
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${DEPLOY_HOST:-192.168.16.62}"
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift ;;
  esac
  shift
done
PORT=15432
DB=loom_conformance
REMOTE_PATH='export PATH=/opt/agentgateway/k8s/bin:$PATH'
remote() { cat deploy/pg.sh - <<<"$1" | ssh "$HOST" "$REMOTE_PATH; bash -s"; }
psql_remote() { remote "pg_psql postgres -Atc \"$1\""; }

echo "==> recreate database ${DB}"
psql_remote "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)" >/dev/null
psql_remote "CREATE DATABASE ${DB}" >/dev/null

SERVICE=$(remote pg_service)
echo "==> tunnel 127.0.0.1:${PORT} → ${SERVICE}:5432"
ssh -L "${PORT}:127.0.0.1:${PORT}" "$HOST" "$REMOTE_PATH; exec kubectl -n loom port-forward svc/${SERVICE} ${PORT}:5432" >/dev/null 2>&1 &
TUNNEL=$!
trap 'kill $TUNNEL 2>/dev/null; psql_remote "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)" >/dev/null || true' EXIT
# ssh -L 一启动就在本地监听，要等远端的 port-forward 真正就绪
for _ in $(seq 1 30); do
  ssh "$HOST" "bash -c 'exec 3<>/dev/tcp/127.0.0.1/${PORT}'" 2>/dev/null && break
  sleep 1
done

echo "==> go test ./internal/store/postgres -run TestConformance"
LOOM_TEST_PG_DSN="postgres://loom:loom@127.0.0.1:${PORT}/${DB}?sslmode=disable" \
  go test -count=1 -v -run TestConformance ./internal/store/postgres/ | grep -E '^ *(--- |PASS|FAIL|ok)|Error'
