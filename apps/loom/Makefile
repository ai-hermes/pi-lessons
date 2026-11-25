# loom Makefile：本地开发 / 测试 / 部署
VERSION ?= $(shell git describe --tags --always 2>/dev/null || echo dev)
TAG      ?= $(VERSION)-$(shell date +%Y%m%d%H%M%S)

.PHONY: build test vet fmt sqlc cross image deploy deploy-fresh smoke run mock tidy clean

build:            ## 本机构建
	go build -ldflags "-X main.version=$(VERSION)" -o bin/loom ./cmd/loom && go build -o bin/loom-mock ./cmd/loom-mock

test:             ## 单元测试（PG 集成测试需 LOOM_TEST_DSN）
	go test ./... $(if $(LOOM_TEST_DSN),,-short)

vet:
	go vet ./...

fmt:
	gofmt -w cmd internal pkg

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

check:            ## 校验配置并打印生效价目表
	go run ./cmd/loom check-config --config configs/config.yaml

run:              ## 本地运行（需要 PG；LOOM_POSTGRES_DSN / LOOM_ADMIN_TOKEN）
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
