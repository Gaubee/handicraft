# OpenSpec Backlog（未来 change 待办）

> 规则：条目只是意图记录，正式启动时在 changes/ 下按规范建 change 并从本表移除。

## [2026-09-18] 服务端化：存储 / 图像处理 / 生成全部上后端（WebSocket + oRPC）

**Owner 原始需求**（2026-09-18，side chat 记录，接近原话）：

> 配置存储到后端。包括图片上传也发到后端，也是后端这边处理完再给前端预览。图片的处理和生成，也都放在后端来处理。这样才能做 headless 测试。后端提供的接口基于 WebSocket + orpc 来提供，确保完全的实时性。

**动机**：
- headless 测试：当前 BYOK 纯前端直连（localStorage 配置 + 浏览器 canvas 处理 + IndexedDB 持久化）在无浏览器环境下不可测；服务端化后全链路可 Playwright/node 直跑
- 实时性：WebSocket + oRPC 承载生成任务进度推送（对齐全局规范的"服务端推送通知 Push → 前端拉取更新 Pull"实时优先范式）
- 中转：图片生成请求由后端代理，key 不再进浏览器

**范围草案**：
1. 配置（BYOK settings）存储迁到后端
2. 图片上传走后端；预处理（降采样/格式校验）与分块预览图由后端处理后回传
3. gpt-image 生成调用移到后端（前端只收结果与进度事件）
4. 引擎（`src/lib/engine/` 纯 TS 零依赖深模块）可直接在 Node runtime 复用——当初设计时特意不 import Svelte，此为本 change 的最大架构红利，迁移时保持"同构引擎、双宿主"
5. 接口层：oRPC over WebSocket，接口极致原子化；任务状态机（pending/running/success/error/cancelled）服务端化
6. 前端 store/persistence 层（lab.svelte.ts / imageStore / taskStore）改为订阅后端事件，UI 组件不动

**技术栈对齐**（用户既定偏好）：orpc + WebSocket + hono；vitest headless 测试全覆盖管线。

**依赖关系**：建议在 `add-rhinestone-studio` 归档后启动；不阻塞当前 UX 迭代收尾。
