# loom Makefile：本地开发 / 测试 / 部署
VERSION ?= $(shell git describe --tags --always 2>/dev/null || echo dev)
TAG      ?= $(VERSION)-$(shell date +%Y%m%d%H%M%S)

GOLANGCI_LINT_VERSION ?= v2.15.0
GOLANGCI_LINT := go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION)

.PHONY: build test vet lint lint-fix lint-config fmt sqlc cross catalog check deploy deploy-fresh smoke run mock tidy clean

build:            ## 本机构建
	go build -ldflags "-X main.version=$(VERSION)" -o bin/loom ./cmd/loom && go build -o bin/loom-mock ./cmd/loom-mock

test:             ## 单元测试（含 race 检测）
	go test -race ./...

vet:
	go vet ./...

lint: lint-config ## 运行固定版本的 golangci-lint
	$(GOLANGCI_LINT) run ./...

lint-fix: lint-config ## 自动修复安全的 lint / formatter 问题
	$(GOLANGCI_LINT) run --fix ./...

lint-config:      ## 校验 .golangci.yml 与当前版本兼容
	$(GOLANGCI_LINT) config verify

fmt:              ## gofumpt + goimports（生成代码除外）
	$(GOLANGCI_LINT) fmt ./...

tidy:
	go mod tidy

sqlc:             ## 重新生成 sqlc 代码（改 queries/*.sql 或 migrations 后执行）
	sqlc generate

cross:            ## 交叉编译 linux/amd64 到 build/
	rm -rf build && mkdir -p build
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o build/loom ./cmd/loom
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o build/loom-mock ./cmd/loom-mock

catalog:          ## 从 pricing.yaml 渲染网关 catalog.json
	go run ./cmd/loom render-catalog --pricing configs/pricing.yaml --out build/catalog.json

check:            ## 校验配置并打印生效价目表（DSN 与 token 只需非空，不连库）
	LOOM_POSTGRES_DSN=postgres://check-config LOOM_ADMIN_TOKEN=check-config LOOM_PRICING_FILE=configs/pricing.yaml \
		go run ./cmd/loom check-config --config configs/config.yaml

run:              ## 本地运行：数据面 :8080、运维面 :9090（需要 PG；LOOM_POSTGRES_DSN / LOOM_ADMIN_TOKEN）
	go run ./cmd/loom serve --config configs/config.yaml

mock:             ## 本地伪 OpenAI 后端 :8080
	go run ./cmd/loom-mock

deploy:           ## 部署到 st2-aii（见 deploy/deploy.sh）
	deploy/deploy.sh --tag $(TAG)

deploy-fresh:     ## 清理 loom + agentgateway-demo 后重新部署
	deploy/deploy.sh --fresh --tag $(TAG)

smoke:            ## 在 st2-aii 上执行验收矩阵
	deploy/smoke.sh

clean:
	rm -rf build bin
