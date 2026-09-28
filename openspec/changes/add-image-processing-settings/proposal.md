# 提案：图像处理设置——三档预设+自定义（Owner 指令 2026-09-28）

## Why

Owner：把图像处理参数产品化——「设置页面提供关于图像处理的一些设置，其中就包括这个多少 PX 每厘米。还有一些 SAM 模型相关的高级参数，也可以放在这里让用户调整。大部分用户不懂调整，提供三档预设：快速档、性能档、高质量档。此外再提供一档『自定义』——自定义模式下把细节参数放开，让用户自己调。」

现状缺口：低像素预处理目标（PPCM）与 SAM 高级参数目前是 daemon env / macmini 服务端缺省（`PPCM_TARGET`/`PPCM_RESAMPLE` env、`confThreshold`/`maskMaxSide` 服务端 clamp 缺省），用户无法在不重启 daemon、不登远端的情况下调整；设置页只有「模型服务」一个分区，没有图像处理面。

## What Changes

1. **设置页升级为多分区**：现有「模型服务」Sheet 升级为通用设置 Sheet（侧栏分区导航，对齐 zhumo AdminPage list-detail 目标形态——ModelsSettingsDialog 文件头注释已预留该语义），新增「图像处理」分区。顶栏入口改为「设置」。
2. **图像处理四档预设**：`快速`/`性能`（缺省）/`高质量`/`自定义`。前三档为冻结映射快照（保存即落当时映射值）；自定义档放开四个细节参数：
   - `ppcmTarget`（10..50 px/cm）——管线入线降采目标密度
   - `resampleEnabled`（bool）——入线降采总开关（=原 `PPCM_RESAMPLE=0` 逃生舱的产品化）
   - `samConfThreshold`（0.05..0.95）——SAM 检出置信度阈值（macmini 服务已支持每请求覆盖）
   - `samMaskMaxSide`（≥32，可空）——SAM 掩码长边降采上限（null=原尺寸）
3. **settings 双层真源**：settings 表新键 `image_processing`（JSON，零迁移）；未写入时生效值回落 env（`PPCM_TARGET`/`PPCM_RESAMPLE`）再回落内置缺省（=性能档映射）；一旦保存即真源（env 不再参与），读面透出生效来源 `settings|env|default`。
4. **调用时解析生效**：`SceneAnalyzer` 由构造期固化 intakeConfig 改为每次 `analyze()` 调用时经注入 provider 解析；SAM 桥请求构造点经注入调谐函数解析 conf/maskMaxSide 并透传 wire params——改设置立即对下一次请求生效，不重启 daemon/kernel。
5. **RPC**：`imageProcessing.get / imageProcessing.save` 两端点（models 六端点同构，requireActiveUser）；契约 schema 落 contracts 新文件。

## Impact

- contracts：新 `src/imageProcessing.ts`（preset enum/values/get-save IO）。
- daemon：新 `image-processing-store.ts`（双层真源+预设映射单源）；`rpc.ts` 端点组；`scene-analyze.ts` provider 化；`sam-bridge.ts` wire params 条件透传；`segment-tool.ts`/`kernel/index.ts` 装配注入。
- studio：`ModelsSettingsDialog` 换多分区壳（ModelsConfig 五组件零改动）；新 `ImageProcessingConfig.svelte`；新 api 客户端。
- 不动：engine/ 零改动；macmini 服务零改动（参数面已就绪）；VLM 模型侧参数（归「模型服务」）；迭代硬顶/停止判据（面积自适应公式保持）。
