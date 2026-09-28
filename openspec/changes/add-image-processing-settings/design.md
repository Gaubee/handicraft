# 设计：图像处理设置——三档预设+自定义

原始需求输入：Owner 2026-09-28 指令（设置页图像处理设置：px/cm+SAM 高级参数；三档预设快速/性能/高质量+自定义放开细节参数）。探底依据：agent_e269a035 现状调查报告（settings 表/models-store 模式/intake-resample 参数面/SAM 桥 wire 参数面/macmini 服务参数面）。

## 0. 参数面裁定（四字段）

| 字段 | 类型/区间 | 消费点 | 依据 |
|---|---|---|---|
| `ppcmTarget` | int 10..50 | `planIntakeResample` 入线降采目标 | 1acf8e2 A/B 裁定缺省 25（1px=0.4mm<最小钻径 1/5）；区间=现有 clamp |
| `resampleEnabled` | bool | 入线降采总开关 | = `PPCM_RESAMPLE=0` 产品化（透传旧行为） |
| `samConfThreshold` | float 0.05..0.95 | SAM 每请求置信度阈值（macmini `do_segment` 已支持临时覆盖+finally 恢复） | 缺省 0.40=macmini `DEFAULT_CONFIDENCE`；区间=服务端 clamp |
| `samMaskMaxSide` | int ≥32 \| null | SAM 掩码长边降采（服务端 PIL NEAREST） | null=原尺寸（缺省）；仅快速档压 1024 |

**排除（non-goals，防扩散）**：
- `topK`：daemon 单检出消费语义（便捷面取最高分）；多候选选择器需独立设计，另开波。
- 迭代硬顶/停止判据（`SEGMENT_LOOP_*`）：面积自适应公式+工具入参语义，不进用户设置。
- VLM `max_tokens`/`temperature`/模型选择：归「模型服务」域。
- 旧 BYOK `SettingsDialog`（dev 旗标遗留）：不动。

## 1. 预设冻结映射（daemon 单源）

```ts
// daemon/src/image-processing-store.ts
export const IMAGE_PROCESSING_PRESET_VALUES = {
  fast:     { ppcmTarget: 15, resampleEnabled: true, samConfThreshold: 0.50, samMaskMaxSide: 1024 },
  balanced: { ppcmTarget: 25, resampleEnabled: true, samConfThreshold: 0.40, samMaskMaxSide: null },
  quality:  { ppcmTarget: 40, resampleEnabled: true, samConfThreshold: 0.30, samMaskMaxSide: null },
} as const satisfies Record<Exclude<ImageProcessingPreset,'custom'>, ImageProcessingValues>
```

- **快速档**：15px/cm（更小的 VLM payload/ssh 传输/像素面，边界代价 ±2-4px≈1.3-2.7mm——15px/cm 口径 1px≈0.67mm（=10/ppcm），上端 2.7mm 已超 2mm 最小钻径）+ conf 0.50（更少更确信的检出，减少重入）+ 掩码压 1024——快速起草定位。15/0.50/1024 为方向性预设，待真实样本校准（质量/耗时收益未由数据证明）。
- **性能档（缺省）**：25px/cm（A/B 实证推荐）+ conf 0.40（服务缺省）+ 原尺寸掩码——当前生产行为逐字段等价，**缺省即现状，零行为漂移**。
- **高质量档**：40px/cm（接近原图密度，多数图不再触发降采）+ conf 0.30（更敏感，小部位/低对比度多检出）+ 原尺寸掩码。40/0.30 为方向性预设，待真实样本校准。
- **自定义**：四字段全放开，保存时 zod 边界校验。

保存语义：**非 custom 档保存时服务端按上映射生成 values 快照落库**（入参 values 忽略——映射单源在 daemon，防客户端篡改）；已保存用户后续不受映射定义演进影响。custom 档 values 必填（缺失 typed 拒）。

## 2. 契约（contracts/src/imageProcessing.ts，新文件）

```ts
export const ImageProcessingPresetSchema = z.enum(['fast','balanced','quality','custom'])
export const ImageProcessingValuesSchema = z.object({
  ppcmTarget: z.number().int().min(10).max(50),
  resampleEnabled: z.boolean(),
  samConfThreshold: z.number().min(0.05).max(0.95),
  samMaskMaxSide: z.number().int().min(32).nullable(),
})
export const ImageProcessingSettingsSchema = z.object({
  preset: ImageProcessingPresetSchema,
  values: ImageProcessingValuesSchema,          // 存储面=快照（非 custom 也存映射快照）
})
export const ImageProcessingEnvStateSchema = z.object({
  ppcmTarget: z.number().int().optional(),      // env 在场的原始值（已 clamp）
  resampleDisabled: z.boolean().optional(),     // PPCM_RESAMPLE=0 在场
})
export const ImageProcessingGetOutputSchema = z.object({
  settings: ImageProcessingSettingsSchema.nullable(),  // 未保存=null
  source: z.enum(['settings','env','default']),
  effective: ImageProcessingValuesSchema,        // 生效值（settings 快照 | env 解析 | 缺省映射）
  env: ImageProcessingEnvStateSchema.optional(),
})
export const ImageProcessingSaveInputSchema = z.object({
  preset: ImageProcessingPresetSchema,
  values: ImageProcessingValuesSchema.optional(),      // custom 必填；非 custom 忽略（服务端映射）
})
export const ImageProcessingSaveOutputSchema = ImageProcessingGetOutputSchema
```

错误码：沿用 typed 拒（invalid-input：custom 缺 values/越界——zod 细节透出）。

## 3. 双层真源（image-processing-store.ts，比照 models-store/allow_anonymous 先例）

settings 表 KV 键 `image_processing`（JSON，零迁移）。

```ts
loadImageProcessing(db, env): ImageProcessingGetOutput
saveImageProcessing(db, input): ImageProcessingGetOutput   // 快照写入+返回读面
imageProcessingEffective(db, env): ImageProcessingValues   // 内部消费面（解析顺序同上）
```

解析顺序（**生效值单源函数**，RPC 读面与 kernel 消费共用）：
1. settings 键在场且 JSON 合法 → `source='settings'`，effective=快照 values。
2. 否则 env 在场（`PPCM_TARGET` 可解析 或 `PPCM_RESAMPLE` 在场）→ `source='env'`：ppcmTarget=clamp(env,10,50,坏值 25)、resampleEnabled=env!=='0'、SAM 两字段无 env 键=回落缺省映射（balanced）。
3. 否则 `source='default'`，effective=balanced 映射。

坏 JSON 容错：按未写入处理（`parseJson` 先例），不 throw。`saveImageProcessing` 写后即真源——**无 models_initialized 式终局标记**（无密钥无复活问题；用户清空设置=删除键回到 env/default 跟随，是期望语义——UI 提供「恢复跟随环境/默认」动作=删键）。

## 4. RPC（rpc.ts，models 端点同构）

```ts
imageProcessing: {
  get:    requireActiveUser → loadImageProcessing
  save:   requireActiveUser → saveImageProcessing → 返回读面
}
```

无桥接面重写（image-processing 无 credentials/settings.yaml 联动——与 models 不同，纯 daemon 内消费）。

## 5. 生效路径（调用时解析，不重启）

### 5.1 入线降采（scene-analyze.ts）

`SceneAnalyzerOptions` 增 `intakeConfigProvider?: () => IntakeResampleConfig`（**直注 `intakeConfig` 保留且优先**——现有测试零改动）；`analyze()` 每次调用时：`const cfg = this.intakeConfig ?? this.options.intakeConfigProvider?.() ?? resolveIntakeResampleConfig()`。kernel 装配（kernel/index.ts 构造 SceneAnalyzer 处）注入 `() => { const v = imageProcessingEffective(db); return { enabled: v.resampleEnabled, ppcmTarget: v.ppcmTarget } }`（better-sqlite3 同步读，零 async 化）。

`resolveIntakeResampleConfig(env)` 保留（env 兜底语义不变，成为 effective 函数的内部细节之一）。

### 5.2 SAM 每请求参数（sam-bridge/segment-tool）

- 桥请求类型增可选 `confThreshold?: number` / `maskMaxSide?: number`；`wireParamsOf` 条件透传（undefined 不发=服务端缺省——**wire 兼容**：旧 macmini 服务不识别字段亦无害，本服务已支持）。
- kernel 装配注入 `samRequestTuner?: () => { confThreshold?: number; maskMaxSide?: number }` 到 segment tool 请求构造点；实现为 `() => { const v = imageProcessingEffective(db); return { confThreshold: v.samConfThreshold, maskMaxSide: v.samMaskMaxSide ?? undefined } }`。
- `SAM_BRIDGE_MOCK` 桥记录收到的 params（供透传断言）。

### 5.3 生效即时不重启的验收口径

同一 kernel 会话内：改 settings → 下一次 `scene-analyze` 用新 ppcm（intake 工件尺寸变）+ 下一次 `subject.segment` wire params 带新 conf——集成测试以注入的 provider/tuner spy 断言两次调用取值不同。

## 6. Studio 设置页

### 6.1 多分区壳（ModelsSettingsDialog 改造）

- Sheet（right, w-[92%] max-w-2xl）内部改 list-detail：左侧窄导航（「模型服务」「图像处理」），右侧分区内容；容器查询窄空间导航折叠为顶部横条。`ModelsConfig` 五组件**零改动**直接挂「模型服务」分区。
- 顶栏入口文案「设置」（data-testid 保留 models-settings-button 兼容既有测试，另加 settings-button 别名？——不：统一改 testid 并同步改既有引用处，grep 收敛）。
- 开合 store 沿用 modelsSettingsDialog（含目标分区参数：`open(section?)`）。

### 6.2 ImageProcessingConfig.svelte（新组件）

- **头部来源行**：`当前生效：设置（快速档）| 环境变量 | 默认（性能档）`（ModelsConfig 头部 source 透明度同构）。
- **预设选择**：四卡单选组（自研按钮组，比照 ModelsConfig tab 条形态；每卡=档名+一句定位+关键值预览：`15 px/cm · 置信度 0.50`/`25 px/cm · 置信度 0.40`/`40 px/cm · 置信度 0.30`/`自行调整四个参数`）。
- **自定义展开**：选 custom 时下方展开参数区（slider/switch，仓库已有 ui 组件）：
  - `ppcmTarget`：slider 10..50 step 1 + 数值显示 + 换算提示（`1px = ${10/ppcm}mm`——25px/cm ⇔ 0.4mm 同口径）
  - `resampleEnabled`：switch（关=原图透传）
  - `samConfThreshold`：slider 0.05..0.95 step 0.05
  - `samMaskMaxSide`：switch「限制掩码长边」+开启时数值 input（≥32，缺省 1024）；关=null
- **保存条**：脏态可用；保存调 `imageProcessing.save`；成功 inline 反馈。「恢复跟随环境/默认」次级动作=删键（rpc save 增 `reset: true` 变体或独立端点——**裁定：save input 增 `z.literal` 联合 `{reset: true}` 分支**，见 §2 契约补充：`ImageProcessingSaveInputSchema = z.union([z.object({reset: z.literal(true)}), z.object({preset, values?})])`）。

### 6.3 api 客户端

新 `rhinestone-studio/src/lib/imageProcessingApi.ts`（ModelsApiClient 同构：独立 WS+匿名 token+zod parse 守门）；`getImageProcessing()`/`saveImageProcessing(input)`。

## 7. 测试面

- **contracts**：schema 往返（custom 缺 values 拒/越界拒/reset 联合分支/nullable maskMaxSide）。
- **daemon**：
  - store：未写随 env（PPCM_TARGET=40→effective 40）/写后真源（env 改动不漂移）/env 越界 clamp/坏 JSON 容错/删键回落。
  - rpc：get 未保存（source=default）/save 快照往返/非 custom 入参 values 被映射覆盖/reset。
  - scene-analyze：provider 两次调用不同值（同实例不重启）+直注优先兼容。
  - 桥：wire params 透传断言（mock 捕获 conf/maskMaxSide；undefined 不发）。
- **studio**：设置页 jsdom 逻辑测试（分区导航切换/预设选择置本地态/custom 展开+slider 绑定/脏态门/保存调用载荷/reset 调用/来源行三态渲染）。
- **真浏览器走查**（vision 子代理）：设置 Sheet 双分区、四档切换、custom 滑杆拖动、保存生效反馈。

## 8. 门

contracts/daemon/studio 聚焦+全量、typecheck、svelte-check、build、`git diff --check`；8317 验收 daemon 换新构建由 MainAgent 收尾统一执行（不触碰运行中实例）。
