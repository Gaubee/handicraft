# 排钻算法 GPU 加速可行性调研

- 日期：2026-09-19（调研代理产出；Owner 提问：「有些算法是非常成熟的，可以考虑转译成 WEBGPU/WEBGL，可以考虑用 GPU.js 来开发。如果能在网络上找到成熟的高性能的实现，可以调研一下」）
- 调研对象：`rhinestone-studio/src/lib/engine/`（先读源码确认实际实现，再逐项对照业界 GPU 实现）
- 实测环境：Apple Silicon（darwin arm64）、Node 24.21、vitest 5（代表中高端客户端 CPU）

---

## 0. 结论先行（推荐路线）

**不建议把 GPU 作为现有确定性引擎的替代实现；建议把 GPU 定位为「预览/交互探索加速器」，以 CVT 策略（实测 1024² 图 43 秒，是全部五策略中唯一的数量级热点）为唯一 P1 试点，用原生 WebGPU 手写 WGSL（不用 GPU.js），跑在现有 computeWorker 内，GPU 结果只用于交互反馈，落盘/导出/重放一律走 CPU 引擎重算，从而完全不触碰「同 seed 逐位重放」与 ENGINE_VERSION 契约。** 决定性理由有三：① WGSL 规范明确允许浮点重结合/融合且不指定舍入模式、除法允许 2.5 ULP 误差（[WGSL §15.7](https://www.w3.org/TR/WGSL/#floating-point-rules)），GPU 路径无法跨设备逐位复现，与产品硬契约正面冲突；② 除 CVT 与 segment 外的全部策略在产品规模（1–2 万钻、1024² 图）CPU 耗时 < 0.5s，GPU 化收益低于通信与双实现维护成本；③ 网络上有成熟 GPU 实现的恰是热点算法（JFA 距离变换/Voronoi、GPU CVT/Lloyd、GPU k-means、GPU CCL），但它们全部是浮点+原子归约实现，拿来即用必然破坏确定性，只能用于预览路径。

---

## 1. 现状实测（CPU 基线，先于任何 GPU 决策）

实测脚本（临时，未入库）：合成「数字油画」式图像（6 色楔形+环带、2px 细线、点阵）→ `segment()` + 五策略 `layout()` 逐段计时。参数 k=8、SS10 @2.5px/mm（pitch 8px）、density=1。

| 阶段 | 512² (0.26Mpx) | 1024² (1.05Mpx) | 2048² (4.19Mpx) |
|---|---|---|---|
| segment（Lab k-means+CCL+DT+中位色） | 432 ms | **977 ms** | **4,216 ms** |
| layout hex-thin | 83 ms | 207 ms（4,720 钻 → 18,924 钻） | 632 ms |
| layout hex-pitch | 54 ms | 117 ms | 524 ms |
| layout poisson | 266 ms | 455 ms | 1,897 ms |
| layout hybrid | 79 ms | 169 ms | 558 ms |
| layout **cvt** | **10.3 s** | **43.1 s**（17,413 钻） | **174.6 s** |
| layout poisson + relax 两钩子 | 374 ms | 1,301 ms | 5,947 ms |
| layout cvt + relax | 9.3 s | 58.5 s | 216.4 s |

结论：

1. **CVT 是唯一数量级热点**：产品典型规模（1024²、约 1.7 万钻）43s；开 relax 后 58s。热点成分（读 `layout/cvt.ts`）：每轮 Lloyd 的逐像素最近站点归属（W×H 次 `del.find`，≤50 轮）+ 每轮重建 Delaunay + `repairSpacing` 的 ≤250 轮 Gauss-Seidel 斥力（每轮重建空间索引）。这恰好是 [Rong et al. 2011《GPU-Assisted Computation of Centroidal Voronoi Tessellation》](https://www.microsoft.com/en-us/research/publication/gpu-assisted-computation-of-centroidal-voronoi-tessellation/)用 JFA+散射归约解决的问题。
2. **segment 是第二热点**（1024² 约 1s）：k-means 全像素分配（1M×k 距离）、逐色 BFS 连通域、逐块 Felzenszwalb EDT、中位色三次排序。
3. **其余策略 CPU 已够**：产品规模全部 < 0.5s；1–2 万钻 60fps 渲染已达标（背景陈述），渲染端不是本次瓶颈。
4. 注意：segment 内 `medianColor` 对每块做三次 O(n log n) 排序、CCL 为标量 BFS——CPU 侧仍有优化空间（并行 worker 化/计数排序/两遍 CCL），「GPU 化之前先榨 CPU」对 segment 是更便宜的路线。

---

## 2. GPU.js 现状（2026-09）

| 维度 | 事实 | 来源 |
|---|---|---|
| 版本/维护 | **2.24.0，2026-08-05 发布**；7 月底以来 2.20→2.24 四连发，处于活跃维护期；15.5k stars、15.6k 周下载 | [npm gpu.js](https://www.npmjs.com/package/gpu.js)、[GitHub gpujs/gpu.js](https://github.com/gpujs/gpu.js) |
| WebGPU 后端 | **2.20.0 起正式提供**：kernel 编译为「WGSL compute shader over storage buffers」，官方基准 M1 Max 1024² matmul ≈ 370× CPU；API 必须 async（`mode:'webgpu'` 或 `mode:'async'`） | [GitHub README](https://github.com/gpujs/gpu.js) |
| TypeScript | 官方 typings + `IKernelFunctionThis` 类型化 kernel | 同上 |
| 体积 | dist `gpu-browser.min.js` **640 KB**（tarball 实测；unpacked 4.3 MB 含源码）；依赖 acorn（kernel 函数解析）、webgpu（旧类型包）、gpu-mock.js | npm tarball 实测 |
| Worker 可行性 | WebGL 后端在 Worker 内需 `new OffscreenCanvas()`；WebGPU 后端不需要 canvas（compute-only）。Vite 下放 Worker 内动态 `import()` 即可懒加载 | [web.dev OffscreenCanvas](https://web.dev/articles/offscreen-canvas)、[Babylon 论坛（WebGPU in worker 的坑）](https://forum.babylonjs.com) |
| 浮点控制 | **无逐位确定性能控项**：默认单精度 f32；`optimizeFloatOutput/optimizeFloatMemory` 等选项只影响精度/性能取舍，不承诺可复现；WebGL 路径 GLSL ES 精度限定符因实现而异 | [GPU.js 文档](https://gpu.js.org) |

判断：GPU.js 适合「快速验证一个数据并行 kernel 能不能加速」的原型阶段；但本引擎需要的算子（JFA 多 pass、原子归约顺序、整数哈希）都需要对 shader 逐行控制，640 KB 依赖换来的抽象层反而是障碍。**建议 GPU.js 仅作 spike 工具，生产路径用原生 WebGPU。**

---

## 3. WebGPU 生态（2026-09）与 fallback

- **浏览器覆盖**：Chrome/Edge 113+（2023-04 起）、Safari 26（2025-06 起默认开）、Firefox 141（2025-07 起默认开）——2025-11 web.dev 宣布「WebGPU 已覆盖所有主流浏览器」；2026 年 MDN/caniuse 均列桌面全绿。移动端 iOS Safari 26+/Android Chrome 可用但旧设备残缺，渐进增强仍是生产建议。来源：[web.dev 宣告](https://web.dev/articles/webgpu-ship)、[caniuse.com/webgpu](https://caniuse.com/webgpu)、[MDN WebGPU API](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)。
- **Worker 内可用性**：`navigator.gpu` 暴露于 Window 与 **DedicatedWorker**（不进 service worker）——与本产品 `computeWorker.ts` 架构直接兼容；compute 管线不需要任何 canvas。来源：[Chromium 讨论串](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/ZEcSLsjCw84)。
- **fallback 策略（业界惯例）**：`navigator.gpu` 存在 → `requestAdapter()`（判 null）→（可选）`featureLevel:'compatibility'` 中间档 → 回退 WebGL2 或纯 CPU。three.js `WebGPURenderer` 即内置「WebGPU 不可用 → WebGL2 backend」自动回退。来源：[three.js webgpu 示例控制台行为](https://threejs.org/manual/#en/webgpu)、[WebGPU Compatibility Mode](https://webgpufundamentals.org/webgpu/lessons/webgpu-compatibility-mode.html)、[MDN requestAdapter](https://developer.mozilla.org/docs/Web/API/GPU/requestAdapter)。
- **纯 TS 写 compute shader**：没有「TS 直接编译到 WGSL」的通用方案；主流是 TS 写管线编排 + 手写 WGSL 字符串（类型由 `@webgpu/types` 提供），教学样板见 [webgpufundamentals compute 教程](https://webgpufundamentals.org/webgpu/lessons/webgpu-compute-shaders-histogram.html)。GPU.js 是唯一把 JS 函数自动编译成 WGSL 的成熟抽象。
- **对本产品的建议**：**不做 WebGL compute fallback**（WebGL compute 需 OffscreenCanvas+纹理乒乓，复杂度一套顶两套）；只做 WebGPU→CPU 双路径，理由见 §7。

---

## 4. 逐算法调研：网络上是否有成熟高性能 GPU 实现

> 「确定性可移植」列 = 该 GPU 实现能否在保持现引擎「同 seed 逐位重放」下直接替换。

| 算法（现实现） | 成熟 GPU 实现存在吗 | 代表出处 | 确定性可移植 | 值得上 GPU 吗 |
|---|---|---|---|---|
| **k-means 图像量化**（Lab + k-means++ 种子 + Lloyd） | **有，教程级现成代码多**：WebGL2 调色板提取（6.5 万像素 ~12ms）、WebGPU compute 版 k-means、WebGPU 直方图归约范式 | [dev.to WebGL2 版](https://dev.to/didof/how-k-means-clustering-works-explained-by-extracting-colors-from-images-pmi)、[r/webgpu WebGPU 版](https://www.reddit.com/r/webgpu/comments/1cjhfne/kmeans_webgpu_implementation_using_compute_shaders)、[Velocaption 教程](https://velocaption.com/blog/k-means-gpu-palette-extractor)、[webgpufundamentals 归约](https://webgpufundamentals.org/webgpu/lessons/webgpu-compute-shaders-histogram.html) | **否**：k-means++ 的 D² 采样是串行 RNG 序列；质心累加用原子加（顺序不定）；f32 距离平局翻转 | **预览档可以**。但 CPU 侧它只占 segment 的一小部分（采样 ≤16384），先优化 CCL/排序更划算 |
| **距离变换 EDT**（Felzenszwalb 精确 1D×2） | **有，JFA 是图形学标配**（近似但实践误差小）；WebGL/WebGPU 现成代码 | [Rong & Tan 原论文](https://www.comp.nus.edu.sg/~tants/jfa.html)、[Wikipedia JFA](https://en.wikipedia.org/wiki/Jump_flooding_algorithm)、[jsjfa（WebGL）](https://github.com/patricklbell/jsjfa)、[Demofox 教程](https://blog.demofox.org/2016/12/08/fast-voronoi-diagrams-and-distance-field-textures-on-the-gpu-with-jump-flooding/)、[Agafonkin Observable notebook](https://observablehq.com) | **整数化后可**：JFA 用整数平方距离则逐位确定（i32 运算 WGSL 精确定义）；但 JFA 是**近似** EDT，与现精确 EDT 输出不同 → 换掉即语义变更 | **有限**：DT 只服务宽度阈值与 boundary 钩子，占比小；若整数化重写才值得 |
| **连通域 CCL**（逐色 4-连通 BFS） | **有，学术 SOTA 成熟**：Block-based Union-Find（BUF）为当前最快 GPU CCL；2018/2024 综述+基准齐备；**无现成 JS/WGSL 库**（如实：搜索未发现可直接用的 WebGPU CCL 包） | [BUF 论文（Allegretti/Bolelli/Grana）](https://www.federicobolelli.it)、[YACCLAB 基准](https://github.com/prittt/YACCLAB)、[Bolelli 2024 SOTA 综述](https://ieeexplore.ieee.org)、ECL-CC（Jaiganesh & Bader 2018）、[Hennequin 2018 GPU 直连标记+轮廓](https://arxiv.org) | **整数化后可**（union-find 全整数控 flag 化）；现成 CUDA 实现不能直接用 | **中**：segment 内占比大，但移植工程量最重（多 pass + 原子）；CPU 侧换两遍标记/行压缩更便宜 |
| **骨架化 Zhang-Suen**（hybrid 的 linear 基底） | **存在但不主流**：Wagner 2019《Real-Time Thinning Algorithms for 2D/3D using GPU》+ 零星 CUDA 仓库；无 WebGPU 实现（如实：这是五个算法里 GPU 生态最薄弱的） | [Wagner 2019（PMC）](https://pmc.ncbi.nlm.nih.gov)、[CUDA 骨架化仓库](https://github.com) | 迭代删除本身可确定（逐子 pass 同步栅栏），实现面窄 | **不值得**：hybrid 全程 169ms@1024²，瓶颈不在此 |
| **CVT/Lloyd 点画**（d3-delaunay + 逐像素累加 + 250 轮修复） | **有，且正是热点**：Rong 2011 JFA-Voronoi+区域归约、NUS 拓扑驱动 GPU CVT、CUDA 版 gCVT；WebGPU 玩具级实现存在（lloyd_gpu） | [Rong 2011（Microsoft）](https://www.microsoft.com/en-us/research/publication/gpu-assisted-computation-of-centroidal-voronoi-tessellation/)、[NUS 版](https://www.comp.nus.edu.sg)、[gCentroidal（CUDA）](https://github.com/orzzzjq/gCentroidal-Voronoi-Tessellation)、[lloyd_gpu（WebGPU demo）](https://github.com/AveryBurke/lloyd_gpu) | **否**：质心累加 = 浮点原子加，顺序不定 → 质心位逐位漂移；JFA 平局判定也随实现变 | **最值得（预览档）**：43s→估 1.5–4s（10–30×），是唯一「用户可感知」收益 |
| **Poisson disk（Bridson 变径）** | 有（PixelPie 光栅化并行 dart-throwing、Ebeida 网格并行消除 1M samples/s、2024 硕士论文） | [PixelPie（UMD/NVIDIA）](https://www.cs.umd.edu)、[Ebeida et al.（Sandia）](https://www.sandia.gov)、[Horský 2024](https://is.muni.cz)、[变半径 CCCG 2012](https://2012.cccg.ca)、[Dwork 2020](https://pmc.ncbi.nlm.nih.gov) | **根本性冲突**：现实现 = 串行 RNG 序列驱动 active list（`Math.floor(rng()*active.length)` 选点顺序即结果）；GPU 并行变体必须改算法语义 | **不值得**：455ms@1024² |
| **六方晶格生成/抽稀**（hex-thin/hex-pitch） | 不需要找：每点独立判定（`valueNoise < d`），trivially parallel；但天然不值得 | — | 整数化可确定（hash01 已是 imul 整数） | **不值得**：54–207ms；数据上传+回读+kernel 启动开销占比过高 |
| Lab ΔE 色映射 / validate 空间 hash | 逐钻最近色、O(n) 邻域——CPU 微秒级 | — | — | 不值得 |

「找不到成熟实现」的如实清单：**WebGPU/JS 生态没有任何一个可直接 npm 安装的 CCL/JFA/CVT 生产库**；所有成熟实现都在 CUDA/OpenCL/论文代码层面，浏览器侧需要照论文手写 WGSL（工作量集中在 CCL 与确定性整数化，而非 JFA——JFA 有足够多的教学实现可抄）。

---

## 5. 确定性风险专节（硬约束正面回答）

**问：GPU 浮点（fast-math/fma 差异）对「同 seed 逐位重放」是不是威胁？**

**答：是，且是规范层面的，无法绕过。**

1. **WGSL 规范明确放弃逐位可复现**（[WGSL §15.7 Floating Point Rules](https://www.w3.org/TR/WGSL/#floating-point-rules)，2026-08 CR 版）：
   - §15.7.5 Reassociation and Fusion：「**An implementation may reassociate operations. An implementation may fuse operations**…」——编译器/驱动可把 `a*b+c` 融合成 fma、可重排结合顺序；
   - §15.7.2 Differences from IEEE-754：「**No rounding mode is specified. An implementation may round an intermediate result up or down**」；次正规数可 flush-to-zero；
   - §15.7.4 精度表：f32 加/减/乘是「correctly rounded」（单算子 IEEE 精确），但**除法允许 2.5 ULP、sqrt 2 ULP、atan2 高达 4096 ULP**——引擎的 `pitch/√d`、质心 `sx/w`、Bridson 的 `cos/sin` 全部落在「允许跨实现不同位」的区间；
   - 即：同一 WGSL，不同 GPU 厂商/驱动/版本可产出不同位型；GPU.js 在此之上更无任何控制项（且默认把 Double 降到 f32 单精度）。
   - 旁证（经典文献）：[RandomASCII《Floating-Point Determinism》](https://randomascii.wordpress.com/2013/07/15/floating-point-determinism/)、[Gaffer on Games](https://gafferongames.com/post/floating_point_determinism/)、[NVIDIA IEEE-754 合规白皮书](https://docs.nvidia.com/cuda/floating-point/)。
2. **CPU 现状本身有一个较小的既存缝隙（如实报告）**：ECMA-262 把 `Math.sin/cos/sqrt/hypot` 定义为 *implementation-approximated*（[tc39.es](https://tc39.es/ecma262/)、[Mac Wright](https://macwright.com/2020/02/14/math-keeps-changing.html)），poisson.ts 的 `Math.cos(ang)*rad`、cvt 的 `Math.hypot` 理论上已可跨引擎差 ULP。实践中主流引擎对这些简单输入一致，且现有「重放漂移」产品语义（同机同浏览器 + ENGINE_VERSION 比对）不因此被破坏。GPU 会把这个缝隙从「理论 ULP 级、实践为零」扩大到「规范允许、必然发生」。
3. **唯一的确定性 GPU 路线 = 整数化/定点化**：WGSL 的 i32/u32 算术（含乘法回绕、`&`、`^`）是**精确定义**的，与 JS `Math.imul` 逐位对齐。引擎的 `mulberry32/hash01/mixSeed/valueNoise`（定点插值）可无损移植到 WGSL；k-means 用缩放整数 Lab、JFA 用整数平方距离、质心用整数累加（i64 或分高低位）亦可精确。**但这等于重写算法语义：输出与现行 Float64 版不同 → 按 version.ts 的 bump 纪律必须 ENGINE_VERSION +1 并注册迁移链**。换言之「GPU 确定版」是一个新引擎版本，不是现有引擎的加速。
4. **GPU.js 是否可控浮点行为：否**（见 §2 表）。它解决「写得快」，不解决「算得定」。

**结论矩阵**：

| 路线 | 逐位重放契约 | ENGINE_VERSION | 工程量 |
|---|---|---|---|
| A. GPU 仅预览，产出走 CPU 重算 | **保留**（落盘数据永远来自 CPU 引擎） | 不动 | 小（一个试点 kernel） |
| B. GPU 作为独立引擎（浮点照抄论文实现） | 破坏（跨设备漂移，横幅会诚实报警） | 需新语义（如 `"2-gpu"`） | 中 |
| C. 整数化 GPU 确定引擎 | GPU 内部可复现，但与历史文件不兼容 | **必须 bump + 迁移链** | 大 |
| D. 不上 GPU，先 CPU 侧优化 CVT | 保留 | 不动（输出不变则不 bump） | 中 |

---

## 6. 收益预估与规模门槛

- **值得**（预览档）：CVT——43s@1024²、175s@2048²，JFA+归约 10–30× 乐观提速到秒级；图像 ≥1024² 或密度调参交互场景收益直接可见。
- **边际**：segment——1s@1024²/4.2s@2048²；GPU 化（k-means 分配+CCL+DT 三算子全部手写）预期到 ~100ms 级，但工程量三倍于 CVT 单算子，且 CPU 侧（worker 并行、计数中位、两遍 CCL）仍有便宜空间。
- **不值得**：hex-thin/hex-pitch/hybrid/poisson/色映射/validate——产品规模 <0.5s，GPU 通信（4MB 图像上传、~10 次 JFA pass 的 kernel 启动、mapAsync 回读）+ 双实现维护成本高于收益。1–2 万钻规模下 CPU 判定为**已够**（本节首行实测表为证）。
- 规模门槛经验值：图像 ≥2048²（≥4Mpx）或「CVT+relax 全开」时，GPU（预览档）才开始有不可替代的体验差。

---

## 7. 集成建议（P0/P1/P2）与现有架构组合

- **P0（现在做，零契约风险）**
  1. CPU 侧 CVT 优化专项：`repairSpacing` 轮数/早停复诊、像素累加降采样或增量 Delaunay、`medianColor` 计数化——目标 43s→<10s；输出逐位不变（不 bump）。
  2. 架构预留：`computeWorker.ts` 启动时探测 `navigator.gpu?.requestAdapter()`（DedicatedWorker 内合法），能力位上报主线程；GPU 模块一律 Worker 内动态 `import()` 懒加载，主包零增重。
- **P1（试点，推荐上限）**：CVT 预览路径——原生 WebGPU 手写「JFA 逐像素最近站点 + workgroup 归约质心」两个 kernel（抄 [Rong 2011](https://www.microsoft.com/en-us/research/publication/gpu-assisted-computation-of-centroidal-voronoi-tessellation/) 结构 + [webgpufundamentals 归约样板](https://webgpufundamentals.org/webgpu/lessons/webgpu-compute-shaders-histogram.html)）；用于密度/seed 调参时的即时视觉反馈；「应用/保存/导出」按钮触发 CPU 引擎精算。GPU 不可用→直接走现状 CPU 路径（`requestAdapter()` 判 null 即回退，同 [three.js 模式](https://threejs.org/manual/#en/webgpu)）。**不做 WebGL compute 后备**。
- **P2（远期，触发条件明确才做）**：仅当产品开出「4K 图 / ≥10 万钻 / 秒级全策略」档位，或 Owner 明确接受整数化语义迁移时，启动路线 C：整数化 WGSL 确定性引擎（`mulberry32/hash01/valueNoise` 先行——它们已全是整数运算），ENGINE_VERSION bump + 迁移链 + round-trip 字节等价测试（version.ts 纪律）。
- **GPU.js 定位**：仅 spike 原型可用（2.24.0 活跃、TS、WebGPU 后端成熟），不进生产依赖（640KB min、无确定性控制、算子需要手写 WGSL 级控制）。

**与 ENGINE_VERSION 的关系（重要）**：只要坚持路线 A（GPU=预览、CPU=产出），`.gemproj` 内记录的 ENGINE_VERSION 永远描述 CPU 引擎，重放漂移横幅语义零改动；一旦任何 GPU 路径开始直接产出落盘钻位，就必须视为语义变更 bump（version.ts bump 纪律原文：「同参数产出不同 blocks/gems/colorId 必 bump +1」）。

---

## 8. 与图层化设计的接口说明（供 PM 代理的「GPU 候选标注位」引用）

建议图层/管线模型中每个算子节点带三个字段，取值即本报告结论：

```
gpuCandidate: "none" | "preview-only" | "future-integer"
gpuNote: string   // 引用本报告章节
```

| 图层管线算子（按 PM 建模粒度） | gpuCandidate | 依据 |
|---|---|---|
| 图像量化/分块 segment.kmeans-assign | preview-only | §4：有成熟 WebGPU 实现，浮点不可复现 |
| segment.connected-components | future-integer | §4：GPU CCL 成熟但需整数化重写 |
| segment.distance-transform | future-integer | §4：JFA 整数化可确定，但近似≠精确 EDT |
| segment.median-color / 排序类 | none | §6：CPU 微优化即可 |
| layout.cvt（Lloyd+修复） | **preview-only（P1 试点）** | §1/§4/§7 |
| layout.poisson | none | §4：串行 RNG 语义根本冲突 |
| layout.hex-thin / hex-pitch / hybrid | none | §6：CPU 已够 |
| 颜色映射 mapColors / validate | none | §4 末行 |
| 渲染层（多图层合成） | （另行调研）| 60fps 已达标；若图层化后层数暴涨，instanced WebGL/WebGPU 渲染另立课题 |

另：图层模型若引入「每层独立 seed/独立引擎调用」，CVT 试点 kernel 应挂在「层计算调度器」之后、与 computeWorker 的进度协议（`ComputeProgress`）复用同一上报通道，避免 GPU 路径另起一套 UI 状态。

---

## 附：主要证据索引

- GPU.js：[GitHub](https://github.com/gpujs/gpu.js)｜[npm](https://www.npmjs.com/package/gpu.js)（2.24.0@2026-08-05，WebGPU 后端 2.20.0 起）
- WebGPU 覆盖：[web.dev 宣告](https://web.dev/articles/webgpu-ship)｜[caniuse](https://caniuse.com/webgpu)｜[MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)
- WGSL 浮点规则：[W3C WGSL §15.7](https://www.w3.org/TR/WGSL/#floating-point-rules)
- JFA/距离变换/Voronoi：[Rong & Tan 论文页](https://www.comp.nus.edu.sg/~tants/jfa.html)｜[Wikipedia](https://en.wikipedia.org/wiki/Jump_flooding_algorithm)｜[jsjfa](https://github.com/patricklbell/jsjfa)｜[Demofox](https://blog.demofox.org/2016/12/08/fast-voronoi-diagrams-and-distance-field-textures-on-the-gpu-with-jump-flooding/)
- GPU CVT/Lloyd：[Rong 2011](https://www.microsoft.com/en-us/research/publication/gpu-assisted-computation-of-centroidal-voronoi-tessellation/)｜[gCentroidal](https://github.com/orzzzjq/gCentroidal-Voronoi-Tessellation)｜[lloyd_gpu](https://github.com/AveryBurke/lloyd_gpu)
- GPU CCL：[BUF（Federico Bolelli 主页）](https://www.federicobolelli.it)｜[YACCLAB](https://github.com/prittt/YACCLAB)｜[2024 综述](https://ieeexplore.ieee.org)
- GPU k-means：[dev.to](https://dev.to/didof/how-k-means-clustering-works-explained-by-extracting-colors-from-images-pmi)｜[r/webgpu](https://www.reddit.com/r/webgpu/comments/1cjhfne/kmeans_webgpu_implementation_using_compute_shaders)｜[webgpufundamentals](https://webgpufundamentals.org/webgpu/lessons/webgpu-compute-shaders-histogram.html)
- GPU Poisson：[PixelPie](https://www.cs.umd.edu)｜[Ebeida（Sandia）](https://www.sandia.gov)｜[Horský 2024](https://is.muni.cz)
- GPU 骨架化：[Wagner 2019](https://pmc.ncbi.nlm.nih.gov)
- 确定性：[RandomASCII](https://randomascii.wordpress.com/2013/07/15/floating-point-determinism/)｜[Gaffer on Games](https://gafferongames.com/post/floating_point_determinism/)｜[NVIDIA](https://docs.nvidia.com/cuda/floating-point/)｜[ECMA-262](https://tc39.es/ecma262/)
- Worker/回退：[Chromium 讨论串（WebGPU in DedicatedWorker）](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/ZEcSLsjCw84)｜[OffscreenCanvas](https://web.dev/articles/offscreen-canvas)｜[three.js 回退行为](https://threejs.org/manual/#en/webgpu)
