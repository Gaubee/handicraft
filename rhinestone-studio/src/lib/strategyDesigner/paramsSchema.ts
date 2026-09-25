/*
 * 七策略族参数表单元数据（add-subject-sam-pipeline P3.2——参数表单「由 registry
 * paramsSchema 驱动」的 UI 侧投影）。
 *
 * 纪律（字面抄录，同 KERNEL_GEM_SHAPE_IDS 先例）：daemon strategies/registry.ts
 * 的各族 paramsSchema 是**校验真源**，UI 不 import daemon——本表把 schema 字段
 * 类型/界/缺省抄录为表单控件描述（number→数字输入界、enum→select、判别键→
 * 变体切换），漂移以 daemon 单测为准；本表完备性（键集===七 kind）由 UI 测试断言。
 *
 * 编辑回写通道（两层编辑铁律）：表单不旁路直写——「生成调整指令」把结构化参数
 * 组装为指令文本注入 Agent 对话输入框（人调参数→Agent 重新提案→批准）。
 */

import type { KernelStrategyKind, StrategyId } from '@handicraft/contracts'

/** 表单控件三态（schema 字段类型→控件映射的完备值域）。 */
export type ParamControl = 'number' | 'select' | 'text'

export interface ParamFieldDescriptor {
  key: string
  label: string
  control: ParamControl
  /** optional=true：可空（缺省由密度推导/自动检测——daemon schema .optional()）。 */
  optional?: boolean
  /** number 界（daemon schema min/max 含端点）。 */
  min?: number
  max?: number
  step?: number
  integer?: boolean
  /** select 选项（daemon z.enum 值域）。 */
  options?: readonly { value: string; label: string }[]
  /** 值由 daemon 侧派生（如 lumaB64 亮度场）——表单只读呈现，不出指令。 */
  derived?: boolean
  help?: string
}

export interface StrategyKindFormSpec {
  kind: KernelStrategyKind
  label: string
  /** 族一句话（daemon STRATEGY_FAMILY_GUIDES.summary 同源缩写）。 */
  note: string
  /** 判别键（texture-fill=mode / geometry=shape——z.discriminatedUnion 投影）。 */
  discriminant?: { key: string; label: string; options: readonly { value: string; label: string }[] }
  /** 判别值缺省（表单初值——daemon schema 字面量顺序首位）。 */
  discriminantDefault?: string
  /** 全变体公共字段。 */
  commonFields: readonly ParamFieldDescriptor[]
  /** 判别值 → 追加字段（无判别 kind 用 'default' 单槽）。 */
  variants: Readonly<Record<string, readonly ParamFieldDescriptor[]>>
}

/** 引擎五策略选项（contracts StrategyId 五值——fallbackEngineStrategy 字段共用）。 */
const ENGINE_STRATEGY_OPTIONS: readonly { value: StrategyId; label: string }[] = [
  { value: 'hex-pitch', label: 'hex-pitch（六方密铺）' },
  { value: 'hex-thin', label: 'hex-thin（六方抽稀）' },
  { value: 'poisson', label: 'poisson（泊松盘）' },
  { value: 'hybrid', label: 'hybrid（晶格+泊松）' },
  { value: 'cvt', label: 'cvt（Voronoi 铺装）' },
]

const fallbackField: ParamFieldDescriptor = {
  key: 'fallbackEngineStrategy',
  label: '降级引擎策略',
  control: 'select',
  options: ENGINE_STRATEGY_OPTIONS,
  help: '节点不足可读下限/引擎显式路由时的降级目标（缺省 hex-pitch）',
}

const colorFamilyField: ParamFieldDescriptor = {
  key: 'colorFamily',
  label: '色彩族',
  control: 'text',
  optional: true,
  help: '色彩族完整性硬门锚点（可选）',
}

/** 七族表单元数据（键集===KernelStrategyKind 七值——测试断言完备性）。 */
export const STRATEGY_FORM_SPECS: Readonly<Record<KernelStrategyKind, StrategyKindFormSpec>> = {
  'texture-fill': {
    kind: 'texture-fill',
    label: '纹理贴图',
    note: '面状/渐变节点首选：Voronoi 满铺 + ETF 流线描边按模式路由',
    discriminant: {
      key: 'mode',
      label: '模式',
      options: [
        { value: 'scatter', label: 'scatter（满铺散布）' },
        { value: 'flow', label: 'flow（顺纹理流线）' },
        { value: 'hybrid', label: 'hybrid（描线+满铺）' },
      ],
    },
    discriminantDefault: 'scatter',
    commonFields: [
      {
        key: 'polarity',
        label: '明暗极性',
        control: 'select',
        options: [
          { value: 'dark-dense', label: '暗部密（dark-dense）' },
          { value: 'bright-dense', label: '亮部密（bright-dense）' },
          { value: 'flat', label: '平铺（flat）' },
        ],
        help: '缺省 dark-dense——暗部排密钻',
      },
      { key: 'lumaB64', label: '亮度场', control: 'text', optional: true, derived: true, help: 'daemon 侧派生（bbox 亮度场 base64）——只读' },
      colorFamilyField,
      fallbackField,
    ],
    variants: {
      scatter: [{ key: 'lloydIters', label: 'Lloyd 迭代', control: 'number', min: 0, max: 16, step: 1, integer: true, help: '受限松弛预算（0=跳过）' }],
      flow: [],
      hybrid: [
        { key: 'lineShare', label: '描线占比', control: 'number', min: 0.05, max: 1, step: 0.05, help: 'flow 线上钻数占比（>0 且 ≤1）' },
        { key: 'lloydIters', label: 'Lloyd 迭代', control: 'number', min: 0, max: 16, step: 1, integer: true },
      ],
    },
  },
  'soft-curve': {
    kind: 'soft-curve',
    label: '柔和曲线',
    note: '布艺/缎带/绳索类：骨架线（Zhang-Suen 细化）沿线布钻',
    commonFields: [
      { key: 'minBranchLengthMm', label: '最短分支（mm）', control: 'number', min: 0, max: 500, optional: true, help: '缺省 0.7×特征间距（碎枝弃）' },
      { key: 'pointSpacingMm', label: '沿线点距（mm）', control: 'number', min: 0.01, max: 500, optional: true, help: '缺省由密度推导' },
      colorFamilyField,
      fallbackField,
    ],
    variants: { default: [] },
  },
  flower: {
    kind: 'flower',
    label: '花形',
    note: '花朵类：极坐标分解——花心圆布+花瓣扇区',
    commonFields: [
      { key: 'petals', label: '花瓣数', control: 'number', min: 3, max: 64, step: 1, integer: true, optional: true, help: '缺省=径向签名自动检测' },
      { key: 'coreRadiusRatio', label: '花心占比', control: 'number', min: 0.05, max: 0.8, step: 0.05, help: '花心圆布半径比（缺省 0.3）' },
      { key: 'petalDensity', label: '花瓣密度', control: 'number', min: 0.2, max: 5, step: 0.1, help: '弧向间距=特征间距/值（缺省 1）' },
      colorFamilyField,
      fallbackField,
    ],
    variants: { default: [] },
  },
  'straight-line': {
    kind: 'straight-line',
    label: '直线族',
    note: '刚硬物（栏杆/杆件/机械）——Owner：机械感慎用',
    commonFields: [
      { key: 'lineSpacingMm', label: '线距（mm）', control: 'number', min: 0.05, max: 200, optional: true, help: '缺省=密度推导间距（下限=钻径）' },
      { key: 'angleOffsetDeg', label: '角度偏移（°）', control: 'number', min: -90, max: 90, step: 1, help: 'PCA 主轴+偏移（缺省 0）' },
      colorFamilyField,
      fallbackField,
    ],
    variants: { default: [] },
  },
  geometry: {
    kind: 'geometry',
    label: '参数化几何',
    note: '星/心/圆/矩/椭圆/螺旋——小节点不足可读下限自动降级引擎 hex',
    discriminant: {
      key: 'shape',
      label: '形状',
      options: [
        { value: 'star', label: 'star（星射线）' },
        { value: 'heart', label: 'heart（心形）' },
        { value: 'circle', label: 'circle（圆形）' },
        { value: 'rect', label: 'rect（矩形）' },
        { value: 'ellipse', label: 'ellipse（椭圆）' },
        { value: 'spiral', label: 'spiral（螺旋）' },
      ],
    },
    discriminantDefault: 'star',
    commonFields: [fallbackField],
    variants: {
      star: [
        { key: 'rays', label: '射线数', control: 'number', min: 3, max: 64, step: 1, integer: true, help: '缺省 5' },
        { key: 'innerRadiusRatio', label: '内半径比', control: 'number', min: 0.05, max: 0.95, step: 0.05, help: '星心留空比例（缺省 0.4）' },
        { key: 'rotationDeg', label: '初始角度（°）', control: 'number', min: 0, max: 360, step: 1, help: '缺省 270=指上' },
      ],
      heart: [
        { key: 'aspectRatio', label: '宽高比', control: 'number', min: 0.5, max: 2, step: 0.05, help: '缺省 1（自然比例 32:29）' },
        { key: 'dentDepth', label: '凹陷深', control: 'number', min: 0, max: 1, step: 0.05, help: '1=经典心形凹陷（缺省）' },
      ],
      circle: [],
      rect: [],
      ellipse: [],
      spiral: [
        { key: 'turns', label: '匝数', control: 'number', min: 0.05, max: 40, step: 0.5, help: '缺省 6' },
        { key: 'pitchMm', label: '螺距（mm）', control: 'number', min: 0.05, max: 100, optional: true, help: '缺省=密度推导' },
        { key: 'decay', label: '衰减', control: 'number', min: 0.2, max: 3, step: 0.05, help: '1=阿基米德等螺距（缺省）' },
      ],
    },
  },
  exclusion: {
    kind: 'exclusion',
    label: '排除',
    note: '不产钻+BOM 未贴区注记——显式指派才生效（值得贴是主观决策）',
    commonFields: [{ key: 'reason', label: '排除原因', control: 'text', help: 'BOM 注记人读溯源（如「灯光不贴」「顾客要求留白」）' }],
    variants: { default: [] },
  },
  'free-code': {
    kind: 'free-code',
    label: '自由代码',
    note: 'LLM 自写排布算法（沙箱执行）——参数经 codeArtifact 工件，表单只读预览',
    commonFields: [],
    variants: { default: [] },
  },
}

/** 当前判别值（params 内取判别键；未知/缺省回 discriminantDefault）。 */
export function discriminantValueOf(spec: StrategyKindFormSpec, params: Record<string, unknown>): string {
  if (spec.discriminant === undefined) return 'default'
  const raw = params[spec.discriminant.key]
  if (typeof raw === 'string' && raw in spec.variants) return raw
  return spec.discriminantDefault ?? Object.keys(spec.variants)[0] ?? 'default'
}

/** 解析后的表单字段集（common + 判别变体追加——顺序即渲染序）。 */
export function fieldsFor(kind: KernelStrategyKind, params: Record<string, unknown>): ParamFieldDescriptor[] {
  const spec = STRATEGY_FORM_SPECS[kind]
  if (spec === undefined) return []
  const variant = spec.variants[discriminantValueOf(spec, params)] ?? []
  return [...spec.commonFields, ...variant]
}

/** 参数摘要（图层树行内一行——「key=value」压缩，derived 字段跳过）。 */
export function summarizeParams(kind: KernelStrategyKind, params: Record<string, unknown>): string {
  const spec = STRATEGY_FORM_SPECS[kind]
  if (spec === undefined) return ''
  const parts: string[] = []
  if (spec.discriminant !== undefined) {
    parts.push(`${spec.discriminant.key}=${discriminantValueOf(spec, params)}`)
  }
  for (const field of fieldsFor(kind, params)) {
    if (field.derived) continue
    const value = params[field.key]
    if (value === undefined || value === '') continue
    parts.push(`${field.key}=${String(value)}`)
  }
  return parts.join(' ')
}

/**
 * 表单编辑 → 结构化调整指令文本（策略层人机面：人调参数→Agent 提案→批准——
 * 不旁路直写）。指令包含节点锚（objectName+nodeId）、策略族、参数全文、密度与钻，
 * 供 Agent 会话按 strategy.design 重新提案。
 */
export function composeAdjustInstruction(input: {
  objectName: string
  nodeId: string
  kind: KernelStrategyKind
  params: Record<string, unknown>
  densityPerCm2: number
  stonesSummary: string
}): string {
  const spec = STRATEGY_FORM_SPECS[input.kind]
  const visibleKeys = new Set(
    fieldsFor(input.kind, input.params)
      .filter((field) => !field.derived)
      .map((field) => field.key),
  )
  const lines = [
    `请调整图层「${input.objectName}」（nodeId=${input.nodeId}）的贴钻策略并重新提案：`,
    `- 策略族：${input.kind}`,
  ]
  if (spec?.discriminant !== undefined) {
    lines.push(`- ${spec.discriminant.key}：${discriminantValueOf(spec, input.params)}`)
  }
  const entries = Object.entries(input.params).filter(([key]) => visibleKeys.has(key))
  if (entries.length > 0) {
    lines.push(`- 参数：${entries.map(([key, value]) => `${key}=${String(value)}`).join('、')}`)
  }
  lines.push(`- 密度：${input.densityPerCm2} 颗/cm²`)
  if (input.stonesSummary !== '') lines.push(`- 用钻：${input.stonesSummary}`)
  lines.push('请按以上图层级参数重新生成策略指派提案（strategy.design），等待我批准。')
  return lines.join('\n')
}
