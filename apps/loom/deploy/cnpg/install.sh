#!/usr/bin/env bash
# 在 st2-aii 的 kind 集群安装 CloudNativePG 平台组件（集群级，只需执行一次）：
#   1) cert-manager（Barman Cloud 插件的 webhook 证书依赖它）
#   2) CloudNativePG operator
#   3) Barman Cloud 插件（WAL 归档、基础备份、PITR）
# loom 命名空间里的 minio（备份目标）与 loom-pg 集群由 deploy/deploy.sh --pg cnpg 创建。
# 上游清单在本机按固定版本下载后 scp 到宿主机；镜像需事先导入 kind 节点（见 docs/loom-extauth-billing.md）。
# 用法：deploy/cnpg/install.sh [--host HOST]
set -euo pipefail
cd "$(dirname "$0")"

HOST="${DEPLOY_HOST:-192.168.16.62}"
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift ;;
    *) echo "unknown arg $1" >&2; exit 1 ;;
  esac
  shift
done

CERT_MANAGER_VERSION=v1.20.5
CNPG_VERSION=1.30.2
BARMAN_PLUGIN_VERSION=v0.16.0
REMOTE_DIR=/opt/agentgateway/loom/cnpg
CACHE=${TMPDIR:-/tmp}/loom-cnpg-manifests
mkdir -p "$CACHE"

fetch() { # url file
  [ -s "$CACHE/$2" ] || curl -fsSL --retry 3 -o "$CACHE/$2" "$1"
}
fetch "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml" \
  "cert-manager-${CERT_MANAGER_VERSION}.yaml"
fetch "https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v${CNPG_VERSION}/cnpg-${CNPG_VERSION}.yaml" \
  "cnpg-${CNPG_VERSION}.yaml"
fetch "https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/${BARMAN_PLUGIN_VERSION}/manifest.yaml" \
  "plugin-barman-cloud-${BARMAN_PLUGIN_VERSION}.yaml"

echo "==> sync manifests to ${HOST}:${REMOTE_DIR}"
ssh "$HOST" "mkdir -p ${REMOTE_DIR}/manifests"
scp -q "$CACHE"/*.yaml "${HOST}:${REMOTE_DIR}/manifests/"

ssh "$HOST" "CERT_MANAGER_VERSION=${CERT_MANAGER_VERSION} CNPG_VERSION=${CNPG_VERSION} \
  BARMAN_PLUGIN_VERSION=${BARMAN_PLUGIN_VERSION} bash -s" <<'REMOTE'
set -euo pipefail
export PATH=/opt/agentgateway/k8s/bin:$PATH
cd /opt/agentgateway/loom/cnpg/manifests

echo "==> [1/3] cert-manager ${CERT_MANAGER_VERSION}"
kubectl apply --server-side -f "cert-manager-${CERT_MANAGER_VERSION}.yaml" >/dev/null
kubectl -n cert-manager rollout status deploy --timeout=300s

echo "==> [2/3] CloudNativePG operator ${CNPG_VERSION}"
kubectl apply --server-side -f "cnpg-${CNPG_VERSION}.yaml" >/dev/null
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager --timeout=300s

echo "==> [3/3] Barman Cloud plugin ${BARMAN_PLUGIN_VERSION}"
kubectl apply --server-side -f "plugin-barman-cloud-${BARMAN_PLUGIN_VERSION}.yaml" >/dev/null
kubectl -n cnpg-system rollout status deploy/barman-cloud --timeout=300s

REMOTE
