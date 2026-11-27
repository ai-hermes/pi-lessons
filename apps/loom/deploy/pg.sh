# shellcheck shell=bash
# 远端脚本共用的 PostgreSQL 访问函数（由 smoke/contract/bench/conformance 拼进 ssh 脚本里执行）。
# 自动识别两种部署形态：CloudNativePG 集群 loom-pg（找当前主库 Pod）或单实例 Deployment loom-postgres。
pg_target() {
  local primary
  primary=$(kubectl -n loom get pod -l cnpg.io/cluster=loom-pg,cnpg.io/instanceRole=primary -o name 2>/dev/null | head -1)
  if [ -n "$primary" ]; then echo "$primary -c postgres"; else echo "deploy/loom-postgres"; fi
}
# pg_psql DB ARGS...：以 loom 用户经 TCP 连接（两种形态都用密码认证）。
pg_psql() {
  local db=$1; shift
  # shellcheck disable=SC2046 # pg_target 输出 "pod -c container"，需要分词
  kubectl -n loom exec $(pg_target) -- psql "postgresql://loom:loom@127.0.0.1:5432/$db" "$@"
}
# pg_service：应用访问主库的 Service 名。
pg_service() {
  if kubectl -n loom get service loom-pg-rw >/dev/null 2>&1; then echo loom-pg-rw; else echo loom-postgres; fi
}
q() { pg_psql loom -Atc "$1"; }
