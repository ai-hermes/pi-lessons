# 真实上游验证

用真实模型（火山方舟按量付费接口，OpenAI 兼容 `/api/v3/chat/completions`）验证 loom 的鉴权、预扣与结算。
默认部署只连 `loom-mock`；这里的清单与脚本单独应用，会产生少量真实费用（每轮约 30 次请求、数千 token）。

## 一、准备

1. 已按 `deploy/deploy.sh` 部署 loom，`configs/pricing.yaml` 中已有要测的方舟模型 ID（当前为 `doubao-seed-2-0-lite-260428`、`deepseek-v4-flash-ga-260731`）。
2. 写入上游凭据 Secret（键 `Authorization`，值 `Bearer <ARK_API_KEY>`）。API Key 从安全位置读入环境变量，不要写进仓库、脚本或终端输出：

```bash
ssh 192.168.16.62 "export PATH=/opt/agentgateway/k8s/bin:\$PATH; \
  kubectl -n loom create secret generic ark-upstream-key --from-literal=Authorization='Bearer $ARK_API_KEY' \
  --dry-run=client -o yaml | kubectl apply -f -"
```

3. 应用后端、路由与策略：

```bash
scp deploy/real/ark.yaml 192.168.16.62:/opt/agentgateway/loom/k8s/real-ark.yaml
ssh 192.168.16.62 'export PATH=/opt/agentgateway/k8s/bin:$PATH; kubectl apply -f /opt/agentgateway/loom/k8s/real-ark.yaml'
```

**通过标准：** `kubectl -n loom get agentgatewaybackend ark-payg` 为 `ACCEPTED=True`，`agentgatewaypolicy ark-chat-ext-auth` 为 `ACCEPTED=True ATTACHED=True`。

## 二、运行

```bash
deploy/real/run.sh            # 可选 --model / --deepseek 指定方舟模型 ID
```

脚本使用专用账户 `real-upstream`（额度 0.1 USD），按顺序执行 10 组场景，每组把客户端收到的 `usage` 与 loom 落库的结算逐项对比：非流式（思考模型）、关闭思考、两种流式写法、上游 400、客户端中途断开（按预扣估值计费）、DeepSeek、前缀缓存、TPM 按实际用量修正、账户扣减与结算总额。

**通过标准：** 末行 `RESULT: PASS=25 FAIL=0`；`NOTE` 行是需要人工关注的观察项，不计入失败。

## 三、清理

```bash
ssh 192.168.16.62 'export PATH=/opt/agentgateway/k8s/bin:$PATH; \
  kubectl delete -f /opt/agentgateway/loom/k8s/real-ark.yaml; kubectl -n loom delete secret ark-upstream-key'
```
