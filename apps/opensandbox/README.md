# OpenSandbox 示例

使用 [`@alibaba-group/opensandbox`](https://www.npmjs.com/package/@alibaba-group/opensandbox) TypeScript SDK 操作 OpenSandbox 沙箱，按服务端部署方式分为两组：

- `k8s/`：Kubernetes 部署的 OpenSandbox
- `compose/`：docker-compose 部署的 OpenSandbox

## 配置

```bash
pnpm install
cp apps/opensandbox/.env.example apps/opensandbox/.env
```

在 `.env` 中至少填写 `OPENSANDBOX_DOMAIN` 和 `OPENSANDBOX_API_KEY`，其余变量按需填写。

## 示例

| 示例 | k8s | compose | 说明 |
| --- | --- | --- | --- |
| 1-basic | `k8s:1` | `compose:1` | 创建沙箱、执行命令、读写文件 |
| 2-storage-host | `k8s:2-host` | `compose:2-host` | 挂载宿主机目录（需设置 `HOST_VOLUME_PATH`） |
| 2-storage-pvc | `k8s:2-pvc` | `compose:2-pvc` | 挂载持久卷，销毁沙箱后数据仍保留 |
| 2-storage-s3-pvc | `k8s:2-s3-pvc` | - | 通过对象存储 StorageClass 动态创建 PVC |
| 2-storage-oss | `k8s:2-oss` | - | 通过 OSSFS 挂载阿里云 OSS（需设置 `OSS_*`） |
| 3-network | `k8s:3` | `compose:3` | 出站网络策略：默认拒绝 + 白名单动态更新 |
| 4-credential | `k8s:4` | `compose:4` | Credential Vault 为出站请求注入凭据 |

运行：

```bash
pnpm --filter opensandbox k8s:1
pnpm --filter opensandbox compose:1
```
