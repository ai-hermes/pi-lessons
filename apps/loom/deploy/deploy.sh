#!/usr/bin/env bash
# 一键部署到 st2-aii（192.168.16.62 上的 kind 集群 agentgateway）：
#   1) 本机交叉编译 linux/amd64 二进制并渲染 catalog.json
#   2) scp 到宿主机 /opt/agentgateway/loom，docker build（FROM busybox:stable）并 kind load
#   3) 按文件名顺序 kubectl apply，从 configs/ 生成 ConfigMap，执行 seed Job
# 用法：deploy/deploy.sh [--fresh] [--tag TAG] [--host HOST]
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${DEPLOY_HOST:-192.168.16.62}"
TAG="$(git rev-parse --short HEAD 2>/dev/null || echo local)-$(date +%Y%m%d%H%M%S)"
FRESH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --fresh) FRESH=1 ;;
    --tag) TAG="$2"; shift ;;
    --host) HOST="$2"; shift ;;
    *) echo "unknown arg $1" >&2; exit 1 ;;
  esac
  shift
done
REMOTE_DIR=/opt/agentgateway/loom
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
ssh "${HOST}" "mkdir -p ${REMOTE_DIR}/{build,k8s,configs}"
scp -q build/loom build/loom-mock build/catalog.json "${HOST}:${REMOTE_DIR}/build/"
scp -q deploy/docker/Dockerfile "${HOST}:${REMOTE_DIR}/Dockerfile"
scp -q deploy/k8s/*.yaml "${HOST}:${REMOTE_DIR}/k8s/"
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
  for f in 01-gateway 03-secret 04-postgres; do kubectl apply -f k8s/\$f.yaml; done
  kubectl -n loom rollout status deploy/loom-postgres --timeout=180s
  for f in 05-loom 06-backends; do sed \"s#IMAGE_TAG#${TAG}#g\" k8s/\$f.yaml | kubectl apply -f -; done
  kubectl -n loom rollout status deploy/loom --timeout=180s
  kubectl -n loom rollout status deploy/loom-mock --timeout=180s
  for f in 07-routes 08-policies 09-telemetry; do kubectl apply -f k8s/\$f.yaml; done
  kubectl -n loom delete job loom-seed --ignore-not-found
  sed "s#IMAGE_TAG#${TAG}#g" k8s/05b-seed-job.yaml | kubectl apply -f -
  kubectl -n loom wait --for=condition=complete job/loom-seed --timeout=180s
  kubectl -n loom logs job/loom-seed | tail -20"

echo "==> [5/5] status"
ssh "${HOST}" "export PATH=/opt/agentgateway/k8s/bin:\$PATH; kubectl -n loom get pods,gateway,httproute,agentgatewaypolicy,agentgatewaybackend -o wide 2>/dev/null | grep -v '^$'"
echo "deployed loom/loom:${TAG}"
