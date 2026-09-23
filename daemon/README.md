# @handicraft/daemon

贴钻后端 daemon（Node TS，tsx 直跑零编译；darwin-arm64 首发）。

## 启动与端口

```bash
pnpm start          # tsx src/index.ts（仓库根：pnpm start）
```

- 默认绑定 `127.0.0.1:8317`（`HOST`/`PORT` 可改；`HOST` 开局域网时 MCP 不随行暴露——design §6.4，W4 接线）
- 首次启动在 daemon 工作目录自动创建 `.env` 模板（0600）；数据落在 `DATA_ROOT`（缺省=仓库 `data/` 自包含数据根）
- 前端构建产物目录 `WEBUI_DIR`（缺省 `../rhinestone-studio/dist`）：**缺失时 daemon 明确报错退出并给出构建指引**（`cd rhinestone-studio && pnpm build`），不静默起服

## .env 键族

| 键 | 说明 |
| --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 管理员唯一建号流程（启动幂等 upsert；轮换=改值重启） |
| `JWT_SECRET` | JWT 签名密钥（空=临时随机，重启后凭证失效） |
| `IMG_BASE_URL` / `IMG_API_KEY` / `IMG_MODEL` | 图像生成 API（服务端集中；半配置=未配置） |
| `LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（`LLM_API` 可选） | Agent LLM（zhumo 同款） |
| `ALLOW_ANONYMOUS` | 匿名访问（**默认 1 开启**——Owner 裁决默认单账户；设 0 关闭） |
| `DATA_ROOT` / `WEBUI_DIR` / `HOST` / `PORT` | 路径与监听 |

## 冒烟与测试

```bash
pnpm smoke:engine   # 引擎 workspace 消费链路 smoke gate（layout/exportSvg/exportBom）
pnpm test           # 单测（config/auth/db/BlobStore）
pnpm test:e2e       # W1.3 E2E 冒烟（随机端口起 daemon→匿名→bootstrap→退出）
```
