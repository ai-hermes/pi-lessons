#!/usr/bin/env bash
# 一键部署到 st2-aii（192.168.16.62 上的 kind 集群 agentgateway）：
#   1) 本机交叉编译 linux/amd64 二进制并渲染 catalog.json
#   2) scp 到宿主机 /opt/agentgateway/loom，docker build（FROM busybox:stable）并 kind load
#   3) 按文件名顺序 kubectl apply，从 configs/ 生成 ConfigMap，执行 seed Job
# 数据库两种形态（--pg）：
#   single  单实例 Deployment loom-postgres（开发演示）
#   cnpg    CloudNativePG 集群 loom-pg（一主两从 + Barman Cloud 备份）；需先执行一次 deploy/cnpg/install.sh 安装平台组件。
# 不指定时沿用集群里的现有形态（都没有时用 single）。切换形态会删除另一种形态的数据库及其数据（cnpg 连同 minio 里的备份）。
# --gateway-image 指定 loom-gateway 数据面镜像（registry/repository:tag），用于验证网关的新版本或 fork 构建。
# 用法：deploy/deploy.sh [--fresh] [--tag TAG] [--host HOST] [--pg single|cnpg] [--gateway-image IMAGE]
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${DEPLOY_HOST:-192.168.16.62}"
TAG="$(git rev-parse --short HEAD 2>/dev/null || echo local)-$(date +%Y%m%d%H%M%S)"
FRESH=0
PG="${LOOM_PG:-}"
GATEWAY_IMAGE="${LOOM_GATEWAY_IMAGE:-cr.agentgateway.dev/agentgateway:v1.7.0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --fresh) FRESH=1 ;;
    --tag) TAG="$2"; shift ;;
    --host) HOST="$2"; shift ;;
    --pg) PG="$2"; shift ;;
    --gateway-image) GATEWAY_IMAGE="$2"; shift ;;
    *) echo "unknown arg $1" >&2; exit 1 ;;
  esac
  shift
done
if [ -z "$PG" ]; then
  PG=$(ssh "$HOST" "/opt/agentgateway/k8s/bin/kubectl -n loom get cluster.postgresql.cnpg.io loom-pg >/dev/null 2>&1 && echo cnpg || echo single")
  echo "==> --pg not given, keeping the current form: ${PG}"
fi
case "$PG" in
  single | cnpg) ;;
  *) echo "--pg must be single or cnpg, got $PG" >&2; exit 1 ;;
esac
REMOTE_DIR=/opt/agentgateway/loom
# registry/repository:tag → 三段，填进 AgentgatewayParameters.spec.image
GATEWAY_IMAGE_TAG="${GATEWAY_IMAGE##*:}"
GATEWAY_IMAGE_REPOSITORY="${GATEWAY_IMAGE%:*}"; GATEWAY_IMAGE_REPOSITORY="${GATEWAY_IMAGE_REPOSITORY##*/}"
GATEWAY_IMAGE_REGISTRY="${GATEWAY_IMAGE%/*}"
KIND_CLUSTER=agentgateway
VERSION="$(git describe --tags --always 2>/dev/null || echo dev)"

echo "==> [1/5] cross compile linux/amd64"
rm -rf build && mkdir -p build
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o build/loom ./cmd/loom
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o build/loom-mock ./cmd/loom-mock
go build -o build/loom-local ./cmd/loom
./build/loom-local render-catalog --pricing configs/pricing.yaml --out build/catalog.json
ls -la build

echo "==> [2/5] sync to ${HOST}:${REMOTE_DIR}"
ssh "${HOST}" "mkdir -p ${REMOTE_DIR}/{build,k8s,configs,cnpg/manifests}"
scp -q build/loom build/loom-mock build/catalog.json "${HOST}:${REMOTE_DIR}/build/"
scp -q deploy/docker/Dockerfile "${HOST}:${REMOTE_DIR}/Dockerfile"
scp -q deploy/k8s/*.yaml "${HOST}:${REMOTE_DIR}/k8s/"
scp -q deploy/cnpg/minio.yaml deploy/cnpg/cluster.yaml "${HOST}:${REMOTE_DIR}/cnpg/manifests/"
scp -q configs/config.yaml configs/pricing.yaml configs/seed.yaml "${HOST}:${REMOTE_DIR}/configs/"

echo "==> [3/5] docker build + kind load (${TAG})"
ssh "${HOST}" "cd ${REMOTE_DIR} && docker build --build-arg BIN_DIR=build -t loom/loom:${TAG} . && kind load docker-image loom/loom:${TAG} --name ${KIND_CLUSTER}"

if [ "$FRESH" = "1" ]; then
  echo "==> [--fresh] delete namespaces loom + agentgateway-demo (controller ns agentgateway is kept)"
  ssh "${HOST}" "export PATH=/opt/agentgateway/k8s/bin:\$PATH; kubectl delete ns loom agentgateway-demo --ignore-not-found --wait=true --timeout=180s"
fi

echo "==> [4/5] kubectl apply in order"
ssh "${HOST}" "export PATH=/opt/agentgateway/k8s/bin:\$PATH; set -e; cd ${REMOTE_DIR}
  kubectl apply -f k8s/00-namespace.yaml
  kubectl -n loom create configmap loom-config --from-file=config.yaml=configs/config.yaml --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n loom create configmap loom-pricing --from-file=pricing.yaml=configs/pricing.yaml --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n loom create configmap loom-catalog --from-file=catalog.json=build/catalog.json --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n loom create configmap loom-seed --from-file=seed.yaml=configs/seed.yaml --dry-run=client -o yaml | kubectl apply -f -
  sed -e \"s#GATEWAY_IMAGE_REGISTRY#${GATEWAY_IMAGE_REGISTRY}#; s#GATEWAY_IMAGE_REPOSITORY#${GATEWAY_IMAGE_REPOSITORY}#; s#GATEWAY_IMAGE_TAG#${GATEWAY_IMAGE_TAG}#\" \
    k8s/01-gateway.yaml | kubectl apply -f -
  if [ ${PG} = cnpg ]; then
    sed 's#@loom-postgres:5432#@loom-pg-rw:5432#' k8s/03-secret.yaml | kubectl apply -f -
    kubectl apply -f cnpg/manifests/minio.yaml
    kubectl -n loom rollout status deploy/loom-minio --timeout=180s
    kubectl apply -f cnpg/manifests/cluster.yaml
    kubectl -n loom wait --for=condition=Ready cluster/loom-pg --timeout=600s
    kubectl delete -f k8s/04-postgres.yaml --ignore-not-found
  else
    kubectl apply -f k8s/03-secret.yaml
    kubectl -n loom delete cluster.postgresql.cnpg.io loom-pg --ignore-not-found 2>/dev/null || true
    kubectl delete -f cnpg/manifests/minio.yaml --ignore-not-found
    kubectl apply -f k8s/04-postgres.yaml
    kubectl -n loom rollout status deploy/loom-postgres --timeout=180s
  fi
  for f in 05-loom 06-backends; do sed \"s#IMAGE_TAG#${TAG}#g\" k8s/\$f.yaml | kubectl apply -f -; done
  kubectl -n loom rollout status deploy/loom --timeout=180s
  kubectl -n loom rollout status deploy/loom-mock --timeout=180s
  for f in 07-routes 08-policies 09-telemetry; do kubectl apply -f k8s/\$f.yaml; done
  kubectl -n loom delete job loom-seed --ignore-not-found
  sed \"s#IMAGE_TAG#${TAG}#g\" k8s/05b-seed-job.yaml | kubectl apply -f -
  kubectl -n loom wait --for=condition=complete job/loom-seed --timeout=180s
  kubectl -n loom logs job/loom-seed | tail -20"

echo "==> [5/5] status"
ssh "${HOST}" "export PATH=/opt/agentgateway/k8s/bin:\$PATH; kubectl -n loom get pods,gateway,httproute,agentgatewaypolicy,agentgatewaybackend -o wide 2>/dev/null | grep -v '^$'"
echo "deployed loom/loom:${TAG} (pg=${PG})"
