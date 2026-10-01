/**
 * 贴钻领域知识库种子（split-admin-portal design §4——zhumo kb/seed.ts 防过拟合结构复刻）。
 * 内容口径：本仓冻结常量与 spec 的既定事实（contracts SS_DIAMETER_TABLE /
 * DEFAULT_DENSITY_PER_CM2 / DELTA_E 三档、engine grid.ts pitch 缺省、strategy-engine
 * 可读兜底下限 3（声明密度优先）、strategies/design.ts 密度绝对语义公式），外加行业通行的 SS 尺码/
 * finish 常识。全部条目标注「来源：整理初版，待领域负责人校订」——模型生成的
 * 常识不自动成标准（design §4 原话），校订后经后台管理面长期演进。
 * 演进约定：种子仅在库为空时落盘一次（ensureSeeded），此后一切增删改走后台
 * 管理面——知识库的长期演进不经过代码发布。
 * value 是 LLM 直读的轻量短文本：无机器解析（消费方是模型，不是代码）。
 */

export interface KbSeedEntry {
  readonly key: string;
  readonly value: string;
}

export interface KbSeedGroup {
  readonly name: string;
  readonly note: string;
  readonly entries: readonly KbSeedEntry[];
}

const SOURCE_NOTE = '（来源：整理初版，待领域负责人校订）';

export const KB_SEED: readonly KbSeedGroup[] = [
  {
    name: '钻径与规格',
    note: '装饰钻尺寸语言：SS 尺码 ↔ 名义直径 mm 换算与选用要点。' + SOURCE_NOTE,
    entries: [
      {
        key: 'SS 尺码表（SS6–SS34）',
        value: [
          'SS 尺码 ↔ 名义直径（mm）：SS6=2.0、SS8=2.4、SS10=2.8、SS12=3.0、SS14=3.5、SS16=4.0、SS18=4.3、SS20=4.8、SS22=5.2、SS24=5.3、SS26=5.8、SS30=6.4、SS34=7.1。',
          '注意：换算非线性，永远查表（contracts SS_DIAMETER_TABLE / engine SS_TABLE 同源镜像），不做插值；精度 ±0.1–0.2mm，SS24=5.3 为中置信补档。',
          '小钻（SS6–SS12）适合细线与高密度纹理；中钻（SS16–SS20）为通用主力的常用档；大钻（SS26+）适合大色块与远观主体，单钻成本与占用面积同步上升。',
        ].join('\n'),
      },
      {
        key: '密度与钻径+gap 的关系',
        value: [
          '钻心最小间距 pitchMm = 钻径 + gapMm（派生量，非独立参数）。gapMm ≥ 0：0=相切，可调范围约 0.4–0.8mm，缺省 0.4mm（转移膜可干净拾取的下限）。',
          '钻径越大、gap 越大 → pitch 越大 → 同面积可容纳颗数越少。最大颗数密度按六方晶格基准容量估算：baseDensityPerCm2 = 2 / (√3 · pitchCm²)（见「密度与单位」组）。',
        ].join('\n'),
      },
      {
        key: '尺寸的物理依据',
        value: [
          '工作台以厘米画布（canvasCm）声明物理尺寸，pixelsPerMm 由底图与画布换算得出；diameterMm 是间距与渲染的唯一物理依据（GridSpec v2——引擎不再依赖 ss 过渡键）。',
          '跨规格混排时每颗钻各自带 diameterMm；等径圆钻场景可用 SS 档位表达，但落到引擎参数时一律以 mm 直径为准。',
        ].join('\n'),
      },
    ],
  },
  {
    name: '密度与单位',
    note: 'densityPerCm2 的绝对语义与基准容量公式——排钻参数的语言学。' + SOURCE_NOTE,
    entries: [
      {
        key: 'densityPerCm2 绝对语义',
        value: [
          'densityPerCm2 永远是绝对颗数密度（颗/cm²，用户/策略层口径），不是相对比例。引擎 density 只是 adapter 内部乘数（densityRatio），两者不可混用。',
          '缺省 2.3 颗/cm²（contracts DEFAULT_DENSITY_PER_CM2，Owner 2026-09-24 定调）；客户成品实测可达约 6.1 颗/cm²。2mm 钻+0.4mm gap 的满铺基准约 20.05 颗/cm²——2.3 约 11.5% 满铺，是稀疏装饰密度而非满铺上限。',
        ].join('\n'),
      },
      {
        key: 'baseDensityPerCm2 公式',
        value: [
          '基准容量按引擎实际晶格（hex 胞元）推导：',
          '  pitchCm = (gemDiameterMm + gapMm) / 10',
          '  baseDensityPerCm2 = 2 / (√3 · pitchCm²)',
          '  densityRatio = densityPerCm2 / baseDensityPerCm2',
          'gap 缺省 0.4mm（ENGINE_DELEGATION_GAP_MM）。例：2mm 钻 + 0.4mm gap → pitchCm=0.24 → base≈20.05 颗/cm²。',
        ].join('\n'),
      },
      {
        key: '超容量拒绝（density-capacity-exceeded）',
        value: [
          'densityRatio > 1（超出基准容量）= typed 拒 density-capacity-exceeded，禁止静默 clamp 到 1（Codex C2 裁定）。降密度、换更小钻径或降 gap 是调用方的显式决策，系统不代选。',
          '密度推导间距（几何族特征间距）：等效方格距 = 10·pixelsPerMm / √(densityPerCm2)，与钻径取大后作为候选点最小间距。',
        ].join('\n'),
      },
    ],
  },
  {
    name: '色系与编码',
    note: '色系命名、SKU 编码解析与 ΔE 色容差三档——选色与替代的语言。' + SOURCE_NOTE,
    entries: [
      {
        key: 'family 色系清单（云目录基础色名）',
        value: [
          '常见色名（SS 云数据表中文色名）：白钻（透明）、白钻AB、黑透、正红、深红（宝石红）、宝蓝、祖母绿、紫晶、浅粉、浅桃、浅黄绿、浅金香槟。',
          'family 是钻库目录的分组字段（自由字符串，导入缺省「未分组」）；色系清单由装饰钻库目录维护，本条目仅作基础参考——新色系以钻库实际入库为准。',
        ].join('\n'),
      },
      {
        key: 'ΔE76 色容差三档（3、10、25）',
        value: [
          '替代决策三档阈值（CIE76，与引擎 Lab 管线同源）：ΔE<3 = NEAR 感知无差，自动替代；3–10 = FAMILY 同色族，自动替代+备注；10–25 = COARSE 粗粒度兜底，须人工确认；>25 拒绝替代。',
          '找相近钻（nearColor/substitutes）时按 ΔE 升序；ΔE 只度量色差，不含尺寸/质感——替代建议同时核对钻径档位与 finish。',
        ].join('\n'),
      },
      {
        key: '供应商 SKU 编码解析（行段制）',
        value: [
          'SKU 编码档案可配置，前缀→毫米映射按行段（band）分段：同一前缀字母在不同行段可映射不同毫米。例（钰航档案）：行 51–75 段 J=2mm，行 76–78 段 J=12mm——J51 解析为 2mm、J76 解析为 12mm。',
          '解析失败（档案未覆盖的前缀或行段外的编码）显式返回原因而非猜测；已入库钻物化解析直值，档案后续修订不回写。同一 供应商×SKU 全库唯一。',
        ].join('\n'),
      },
    ],
  },
  {
    name: '工艺规则',
    note: '排钻成品的可读性与可制作性守卫——什么时候拒绝而不是硬排。' + SOURCE_NOTE,
    entries: [
      {
        key: '贴钻最小间距',
        value: [
          '钻间隙 gapMm ≥ 0（0=相切）；钻心最小间距 pitchMm = 钻径 + gapMm 为派生量，不设独立 minSpacing 字段。',
          '转移膜工艺下 gap 缺省 0.4mm（可干净拾取的下限），可调约 0.4–0.8mm；gap 过小拾取易粘连，过大稀疏露底。',
        ].join('\n'),
      },
      {
        key: '可读兜底下限 3 颗（声明密度优先）',
        value: [
          '声明密度是承诺：2.3 颗/cm² 就是每 cm² 2.3 颗（部位内均匀/保形），小部位颗数少是正确结果（3.6cm² 左手 ≈8-13 颗就是 8-13 颗）；「满铺」只在策略显式要求时发生（2026-10-01 真链走查 P1 裁定，旧「≥24 颗才自产钻」规则废止——它把小部位强制降级 hex 满基准密度，声明密度形同虚设）。',
          '可读性兜底仅在极小产出（<3 颗）时触发：声明式降级到指派的引擎策略（缺省 hex-pitch，目标密度不变仅形态兜底），记 reason=geometry-min-size 的降级注记+warning 如实说明。',
        ].join('\n'),
      },
      {
        key: '超容量拒绝',
        value: [
          '目标密度超出钻径+gap 的基准容量（densityRatio>1）= typed 拒，见「密度与单位」组的公式条目。同理：面积×密度的期望颗数与晶格容量矛盾时，先降密度或换规格，不做静默截断。',
        ].join('\n'),
      },
    ],
  },
  {
    name: '材质与finish',
    note: '装饰钻质感（finish）与材质常识——选型与替代的辅助维度。' + SOURCE_NOTE,
    entries: [
      {
        key: '常见 finish 清单',
        value: [
          '常见质感：glossy（亮面/镜面，最常用）、matte（哑面）、AB（Aurora Borealis 镀彩——表面虹彩镀膜，如「白钻AB」）、frosted（磨砂）、opal/乳白（半透乳光）。',
          '钻库 stone.json 的 color.finish 为自由字符串；样卡草表不含质感字段时导入缺省 unspecified（不猜测 glossy，人审可改）。',
        ].join('\n'),
      },
      {
        key: '材质常识',
        value: [
          '主流为玻璃钻（折射率高、亮度好，脆性略高）与树脂钻（轻、韧、成本低，亮度略低）；同一颜色名在不同材质下观感差异明显——替代建议优先同材质。',
          'AB 镀膜会明显偏色（白钻AB 的 RGB 采样即带虹彩偏光），按色选钻时注意 finish 相同才可比色；ΔE 替代建议须同 finish 或明示差异。',
        ].join('\n'),
      },
    ],
  },
];
