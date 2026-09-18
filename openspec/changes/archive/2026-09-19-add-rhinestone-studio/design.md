<!--
Orthogonal intents (max 5):
1. [2026-09-18 Architecture] 引擎纯 TS 深模块，策略接口统一，UI 只是消费者。
2. [2026-09-18 Algorithm] 构造为主（解析最优：六方密排），收敛为辅（CVT/边界 1D Lloyd/斥力修复三落点）。
3. [2026-09-18 Production] 硬约束在任何输出上恒真：最小间距、钻心在掩码内、无半钻、带病禁导出。
4. [2026-09-18 UX] 多算法同屏对比 + 每块密度滑杆，人类视觉裁决是产品形态本身。
-->

## Purpose

冻结 rhinestone-studio 的模块拓扑、引擎 API 契约、算法族与密度语义、BYOK 网络层决策。这些决策由样本实证（tech-research.md）与参考项目探查（openai-image-webui）共同支撑。

## 1. 数据流拓扑

```text
[模块 A 提示词实验室]                     [模块 B 转化工作台]
原图上传(预处理)                          数字油画(来自A或上传)
  → 提示词变体组 (Variant[] 可编辑)         → 分块 segment()
  → gpt-image-2.5 BYOK 并发生成              Lab k-means(k=6..10) → 连通域 → Block[]
    (每变体×N候选, 恒发 n:1)                 宽度统计(距离变换) → 类型推断
  → 分组画廊 (variant→candidates)           → layout(strategy, block, density) → Gem[]
  → 叠加/并排预览 (透明度滑杆)               5 策略 × 松弛钩子 → 对比网格
  → 选中 → 送转化 ──────────────→          → colorMap(Lab ΔE) → validate() → export()
                                            SVG(按色分层) / BOM CSV / PNG
```

## 2. 深模块与接口（引擎契约，UI 依赖此契约开发）

```ts
// src/lib/engine/types.ts —— 唯一公共面，Svelte 组件禁止 import 引擎内部实现路径
export interface GridSpec { ss: SSKey; pitchMm: number; rowAngleDeg: 0 }
export interface Block {
  id: string; label: string;
  mask: { w: number; h: number; bits: Uint8Array };   // 0/1 位掩码
  colorRgb: [number, number, number];                  // 块代表色（中位色）
  areaPx: number; bbox: { x: number; y: number; w: number; h: number };
  widthPx: { max: number; mean: number };              // 距离变换统计
  suggested: "fill" | "linear" | "element";            // 宽度阈值推断，用户可覆写
}
export interface Gem { id: string; x: number; y: number; colorId: string; blockId: string }
export type StrategyId = "hex-thin" | "hex-pitch" | "poisson" | "hybrid" | "cvt";
export interface LayoutOptions {
  density: number;            // 0<d≤1，块级
  seed: number;               // 确定性重放
  relax: { boundary: boolean; repulsion: boolean };
}
export interface LayoutResult { gems: Gem[]; warnings: Warning[] }
export interface Warning { kind: "spacing" | "island" | "mask"; detail: string }
// 管线入口（纯函数，无副作用，同输入同输出）
export function segment(image: ImageBitmap, opts: SegmentOptions): Block[]
export function layout(blocks: Block[], strategy: StrategyId, opts: LayoutOptions, grid: GridSpec): LayoutResult
export function mapColors(gems: Gem[], blocks: Block[], palette: Palette): void
export function validate(gems: Gem[], grid: GridSpec): Warning[]
export function exportSvg(result: LayoutResult, grid: GridSpec): Blob
export function exportBom(result: LayoutResult, palette: Palette): Blob
```

### 不变量（violation 即 bug）

1. 任意两钻中心距 ≥ pitch × 0.999（容差防浮点）。
2. 钻心必须落在其 block 掩码内（中心点规则 → 天然无半钻）。
3. 同 block 同 density 同 seed → Gem[] 逐位相同（确定性）。
4. 块内钻数随 density 单调不减。
5. validate 报 spacing 违规的输出禁止进入 export。

## 3. 算法族与密度语义（构造 vs 收敛的裁决记录）

**裁决依据**：恒定密度的均匀覆盖最优排布存在解析闭式——等径圆最密堆积即六方密排（Thue 定理），Lloyd 松弛在均匀场下的极限也是局部六方；且样本实证要求全局行向对齐，CVT 只能收敛出局部六方畴（畴界错行）。故构造式直接站在解析最优上，收敛算法只上桌"无闭式"的三处。

| 策略 | 机制 | density 映射 | 收敛成分 |
|---|---|---|---|
| S1 hex-thin | 全局冻结六方晶格 + blue-noise(RIPD) 抽稀 | 保留概率 p=d | 无（构造） |
| S2 hex-pitch | 六方晶格 pitch=d^(−1/2)·pitch₀ | 间距缩放 | 无（构造） |
| S3 poisson | Bridson 变径 Poisson disk | r=d^(−1/2)·r₀ | 无（构造） |
| S4 hybrid | 宽块 hexFill / 细块(width<3钻径) Zhang-Suen 骨架+等弧长链 | 链距/填充 pitch 缩放 | 无（构造） |
| S5 cvt | 密度场加权 Voronoi stippling（Secord 2002 谱系），块密度构成标量场 ρ(x,y) | ρ ∝ d（连续过渡，唯一非阶跃） | Lloyd 迭代 20–50 轮，max 位移<ε 早停 |

**松弛钩子**（任意策略可开关的后处理）：

- boundary（边界 1D Lloyd）：最外圈钻投影到掩码边界曲线，沿弧长一维质心均匀化。修复冻结晶格在弯曲边界的锯齿。
- repulsion（斥力修复）：Verlet 式违规对互推 + 掩码投影回弹，K 轮至零违规；修不掉的残留由 validate 报 warning 并阻断导出。

**依赖**：d3-delaunay（S5 的 Voronoi，轻量独立包）；Zhang-Suen/形态学/连通域/距离变换自实现（opencv.js 默认构建不含 ximgproc，自编译 WASM 维护成本高——tech-research.md §2.1 已验证）。

## 4. BYOK 网络层（整体移植 openai-image-webui 模式）

- baseUrl 自由填写（官方/中转站）、apiKey 存 localStorage、裸 fetch 无 SDK；`VITE_*` 环境变量只放默认模型名（Vite 会内联 env，key 绝不入 .env）。
- 端点：无参考图 `POST {base}/images/generations`（JSON）；有参考图 `POST {base}/images/edits`（multipart，重复 `image` 字段）。**永远发 n:1**，多候选 = 客户端并发独立请求（单图可重试、进度独立）。
- Advanced JSON 逃生舱：`background:"transparent"`、`quality`、`seed` 等直接透传合并进请求体，upstream 报错原样展示。
- 响应同时兼容 `data[0].url` 与 `data[0].b64_json`；FormData 不手动设 Content-Type（boundary 必须浏览器生成）。
- 上传预处理：MIME 白名单 png/jpeg/webp、>2048px canvas 降采样（PNG 保 alpha）、参考图数量仅启发式警告不阻断。
- debug 对象：请求/响应全量截断脱敏记录（b64 截断 1000 字符），错误可展开排查中转站问题。
- 持久化：生成图写 IndexedDB；任务/设置写 localStorage 并做三级配额降级（全量→去 payload→只留最近 50 条）。

## 5. UI 结构（Svelte 5 runes）

```text
App.svelte
├── 顶栏: 视图切换(实验室/工作台) + 设置(BYOK)
├── Lab/      GenerationForm(变体编辑器+批量)  TaskQueue(分组卡片)
│             PreviewModal(放大/叠加/并排/透明度)  Dropzone(原图上传)
└── Studio/   BlockCanvas(分块图+点选)  BlockPanel(每块: 开关/密度/类型/颜色覆写)
              CompareGrid(5策略×开关松弛 同屏)  ExportBar(SVG/BOM/PNG + 预估钻数)
```

- 状态用 `.svelte.ts` runes 模块（$state/$derived），不引入状态库。
- 画布渲染走原生 canvas + SVG，不用图表库；对比网格为同一 Gem[] 的五份渲染，纯展示无交互差异。
- 提示词变体默认包（5 组，来自实证规则，全部可编辑）：严格扁平硬删氛围 / 保留部分渐变 / 描边强调 / 浆果逐颗圆点 / 极简高光。

## 6. 技术选型证据

- Vite 8（2026-03 转正，Rolldown 内核）+ @sveltejs/vite-plugin-svelte 最新版配对；shadcn-svelte 与 Svelte 5 + Tailwind v4 完全兼容（官方 CLI 支持 Tailwind v4 初始化），Vite 版本不直接影响组件库；脚手架任务首步验证，不兼容即降 Vite 7 并在 tasks 勾注。
- vitest + jsdom（用户既定偏好）；zod v4 校验 API 响应与设置；ts-pattern 做策略分派。
- 引擎测试用 Boston 样本（`3-src.jpg`）派生 fixture（合成掩码），不依赖网络。
