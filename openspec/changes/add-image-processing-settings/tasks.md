# Tasks：图像处理设置——三档预设+自定义

## 1. 契约与 daemon（子代理 A）

- [x] 1.1 contracts 新 `src/imageProcessing.ts`：Preset/Values/Settings/EnvState/GetOutput/SaveInput(含 reset 联合分支)/SaveOutput schema + 导出聚合；单测（custom 缺 values 拒/越界拒/nullable 往返/reset 分支）
- [x] 1.2 daemon 新 `src/image-processing-store.ts`：`IMAGE_PROCESSING_PRESET_VALUES` 冻结映射（fast 15/0.50/1024、balanced 25/0.40/null、quality 40/0.30/null）+`loadImageProcessing`/`saveImageProcessing`（非 custom 服务端映射快照）/`imageProcessingEffective` 单源解析（settings→env→default）+删键 reset；单测（未写随 env/写后真源/env clamp/坏 JSON/删键回落）
- [x] 1.3 `rpc.ts` 端点组 `imageProcessing.{get,save}`（requireActiveUser，models 同构）；rpc 集成测试（未保存 source=default/快照往返/非 custom values 被映射覆盖/reset 回 env-default）
- [x] 1.4 `scene-analyze.ts`：`intakeConfigProvider` 注入面（analyze() 调用时解析；直注 `intakeConfig` 保留优先）；kernel 装配注入 db 读 provider；测试（同实例两次 analyze 不同 ppcm+直注兼容零改动）
- [x] 1.5 SAM 桥：请求类型可选 `confThreshold`/`maskMaxSide` +`wireParamsOf` 条件透传（undefined 不发）；segment-tool/kernel 装配注入 `samRequestTuner`；mock 桥记录 params；测试（透传在场/缺省不发/设置改动→下一次请求参数变）

## 2. Studio（子代理 B，依赖 1.1 契约冻结后并行）

- [x] 2.1 新 `lib/imageProcessingApi.ts`（ModelsApiClient 同构：独立 WS+zod parse 守门）`getImageProcessing`/`saveImageProcessing`
- [x] 2.2 `ModelsSettingsDialog` 升级多分区壳：侧栏导航（模型服务/图像处理）+容器查询窄空间折叠；ModelsConfig 零改动挂载；顶栏入口「设置」（testid 统一改+既有引用同步）；开合 store 增目标分区参数
- [x] 2.3 新 `ImageProcessingConfig.svelte`：来源行三态+四卡预设组（含关键值预览）+custom 展开（ppcm slider 含 1px=?mm 换算提示/resample switch/conf slider/maskMaxSide switch+input）+脏态保存条+「恢复跟随环境/默认」reset 动作
- [x] 2.4 studio 测试：分区导航/预设选择/custom 展开/脏态门/保存载荷/reset/来源行渲染（jsdom 逻辑测试）

## 3. 合流与验收（MainAgent）

- [x] 3.1 子代理返回 review+整合；契约漂移抽查（A/B 两面 schema import 一致）
- [x] 3.2 全量门：contracts+daemon+studio 全量/typecheck/svelte-check/build/`git diff --check`
- [x] 3.3 vision 子代理真浏览器走查：设置 Sheet 双分区/四档切换/custom 滑杆/保存反馈（隔离端口 daemon，不触碰 8317/5200）
- [x] 3.4 spec delta 落盘（specs/settings/spec.md）+tasks 按内容勾选+提交
- [x] 3.5 Codex 复核闭环（change 意图确认+实现终评）
