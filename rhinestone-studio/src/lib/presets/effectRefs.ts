/**
 * 变体级「案例图」内置案例（真实来源）。
 * [2026-09-19 融合] 变体与案例一一绑定：本文件同时是默认变体集合的数据源
 * （见 lab.svelte.ts defaultVariants），preset kind 语义 =「内置案例图」
 * （静态路径直引），无库选择交互。
 *
 * 正交意图：
 * 1. [2026-09-19][Owner 否决手写模板] 基于真实局部贴钻产品案例（本仓 3 组对照样本
 *    + Diamond Dotz / Heartful Diamonds 产品页案例）提供差异化提示词模板。
 * 2. 每条 prompt =「原图 → 贴钻效果中间稿」的转化规则（英文），风格路线彼此互异；
 *    公共硬约束（元素级二元决策 / 氛围层剔除 / 5-6 色 / 闭合纯色形状）收敛为
 *    RHINESTONE_COMMON_RULES 单一常量，依据 tech-research.md §1 样本实证。
 * 3. 图片资产位于 public/presets/（sips -Z 800、单张 ≤150KB），根相对静态路径引用。
 *
 * 消费方契约（与占位版一致）：只依赖 EffectRefPreset 接口形状与
 * 「resImage 恒非空、srcImage 允许空串（无原图对）」的约定，不依赖条目数量或具体 id。
 * 调查依据：.agents/documents/2026-09-19-effectref-research/cases.md。
 */

export interface EffectRefPreset {
  /** 稳定 id（同时是 public/presets/ 下的文件名主干）。 */
  id: string
  /** 中文名。 */
  name: string
  /** 一句话说明该案例的贴钻转化风格。 */
  summary: string
  /** 该案例对应的生成指令正文（英文，已拼接公共规则）。 */
  prompt: string
  /** 案例来源说明（tooltip 展示；真实来源，仅供内部工具静态展示）。 */
  sourceNote: string
  /** 案例原图（印刷品照片/设计稿）；空串 = 仅有效果图、无原图对。 */
  srcImage: string
  /** 案例贴钻效果图（恒存在）。 */
  resImage: string
}

/**
 * 公共硬约束（tech-research.md §1 三组对照样本实证结论的规则化）：
 * 元素级二元决策、氛围层永不贴、调色板收敛 5-6 色、闭合纯色形状、
 * 统一粒径圆钻六方密排、细于 1 钻径的特征整段放弃。
 */
const RHINESTONE_COMMON_RULES = [
  'Global rules for the rhinestone intermediate draft:',
  '- Work at element level: every distinct element is either fully converted into a drillable area or fully left as un-drilled print; never partially convert one element.',
  '- Reduce the whole design to 5-6 flat, clearly separated colors. Every color area is one closed solid-color shape with clean print-ready outlines. No gradients, no shading, no texture, no noise, no glow effects.',
  '- Never drill atmosphere: sky, falling snow, ground, pavement, water, distant scenery and background people stay as plain flat print (or are removed to plain white).',
  '- Gems are uniform round dots of a single size on a tight honeycomb packing; drop every detail thinner than one dot diameter instead of shrinking it.',
  '- Pure white (or fully transparent) background; the result must read as a crisp stencil-like color separation ready for gem placement.',
].join('\n')

const withCommonRules = (specific: string): string => `${specific}\n\n${RHINESTONE_COMMON_RULES}`

export const EFFECT_REF_PRESETS: EffectRefPreset[] = [
  {
    id: 'new-orleans',
    name: '城市分层·全要素',
    summary: '边框花环＋大字标题＋英雄主体＋骨架链＋点光的全要素分层公式，节日城市场景的完整路线。',
    prompt: withCommonRules(
      [
        'Convert the input photo into a full-layer festive rhinestone artwork that keeps every layer of the scene, each layer simplified by its own rule:',
        '(1) Border: a wreath-style frame of leaves, berries and small blossoms; each berry is one gem dot, each petal is one gem plus a gold center dot.',
        '(2) Headline: any large title lettering becomes solid gem-packed blocks in one accent color; small caption text stays un-drilled.',
        '(3) Hero subject: rebuild the main subject as 2-4 closed part-colored gem fields (body, trim, key props), gem colors following the subject own material colors.',
        '(4) Linear structures: branches, railings, spires, poles and thin instruments reduce to one-gem-wide dot chains following their skeleton.',
        '(5) Light sources: drill only the glowing part (flame, lit window, lamp glass), never the support structure.',
        'Suggested palette: red, gold/amber, ivory-pearl, deep green, charcoal.',
      ].join('\n'),
    ),
    sourceNote: '本仓样本 01（Christmas in 城市系列贴钻套装，印刷稿→贴钻成品对照）',
    srcImage: '/presets/new-orleans-src.jpg',
    resImage: '/presets/new-orleans-res.jpg',
  },
  {
    id: 'savannah',
    name: '城市分层·骨架主角',
    summary: '单一英雄主体＋一钻宽线性骨架链的减层路线，背景压成平面印刷、不加边饰。',
    prompt: withCommonRules(
      [
        'Convert the input photo into a hero-first rhinestone artwork where one main subject carries the whole design:',
        '(1) The hero subject is rebuilt as large closed part-colored gem fields; the biggest 2-3 fields dominate the canvas, colors sampled straight from the subject (coat, bodywork, fabric).',
        '(2) Everything thin and linear around it (branches, masts, railings, stems, cables) becomes one-gem-wide skeleton chains that lead the eye toward the hero; any chain wider than three gem diameters turns into a filled field instead.',
        '(3) No decorative border and no scattered ornaments: at most one small corner accent cluster.',
        '(4) All context — ground, sky, distant buildings, people — is stripped to flat un-drilled print.',
        'Suggested palette: 2 subject colors + ivory-pearl + gold + charcoal.',
      ].join('\n'),
    ),
    sourceNote: '本仓样本 02（Christmas in 城市系列贴钻套装，印刷稿→贴钻成品对照）',
    srcImage: '/presets/savannah-src.jpg',
    resImage: '/presets/savannah-res.jpg',
  },
  {
    id: 'boston',
    name: '城市分层·字光主角',
    summary: '超大标题字与发光体双主角：字实铺钻、光源只贴发光部、其余压成两色调剪影。',
    prompt: withCommonRules(
      [
        'Convert the input photo into a type-and-light rhinestone artwork anchored by oversized lettering:',
        '(1) The main title word becomes the visual anchor: thick letterforms solidly packed with gems in one strong color; counters and thin serifs narrower than one gem diameter are simplified away.',
        '(2) Light-emitting elements (lanterns, lit windows, beacon glass, lamp posts) are the only bright drilled areas: drill just the glowing shape in a single luminous color and drop the fixture hardware.',
        '(3) Supporting scenery reduces to 2 muted tones of flat silhouette print; small secondary text stays un-drilled.',
        'Suggested palette: 1 bold title color + luminous gold/ivory for lights + 2 muted support tones + charcoal line.',
      ].join('\n'),
    ),
    sourceNote: '本仓样本 03（Christmas in 城市系列贴钻套装，印刷稿→贴钻成品对照）',
    srcImage: '/presets/boston-src.jpg',
    resImage: '/presets/boston-res.jpg',
  },
  {
    id: 'wreath-border',
    name: '花环边框·浆果环带',
    summary: '环形构图：浆果逐颗一钻、叶片闭合平色、蝴蝶结两大色块，环心与环外全部留印。',
    prompt: withCommonRules(
      [
        'Convert the input photo into a ring-shaped wreath rhinestone artwork:',
        '(1) The design is a circular wreath band; the ring itself is built from leaf, berry and ornament elements: each berry or ornament is one gem (or a tight 3-7 dot mini-cluster), each leaf or petal is one closed flat shape with an optional gold center dot.',
        '(2) A bold bow or comparable accent sits at the base of the ring as two clean solid-color fields with a simple knot silhouette.',
        '(3) The hollow center of the ring and everything outside the ring stay un-drilled flat print: the sparkle lives only on the band.',
        '(4) Keep an even dot rhythm around the whole ring; no element thinner than one gem diameter.',
        'Suggested palette: green, red, gold, ivory-pearl, charcoal.',
      ].join('\n'),
    ),
    sourceNote:
      'Diamond Dotz Christmas Wreath 产品页（partial coverage 圆钻套装）: https://www.diamonddotz.com/products/christmas-wreath-diamond-painting-kit',
    srcImage: '',
    resImage: '/presets/wreath-border-res.jpg',
  },
  {
    id: 'angel-dress',
    name: '人物主体·礼服大色块',
    summary: '单人物路线：礼服铺成两大色块、翼与光环作发光剪影、脸与皮肤留给印刷。',
    prompt: withCommonRules(
      [
        'Convert the input photo into a single-figure rhinestone artwork of one graceful central figure:',
        '(1) The flowing garment is the largest gem field: drape it as one dominant closed color field plus at most one deeper fold tone — two levels only, no finer shading.',
        '(2) Wings and halo are treated as light: drill them as clean silhouette fields in one luminous ivory/gold tone so they read as glow without any gradient.',
        '(3) Face and skin stay un-drilled print: never fill faces with dots.',
        '(4) Trim details (hem, sash, small stars) become sparse single-gem accents along the garment outline.',
        'Suggested palette: garment red, deep-red fold, gold, ivory-pearl, charcoal.',
      ].join('\n'),
    ),
    sourceNote:
      'Diamond Dotz Joy to the World 产品页（partial coverage 圆钻套装）: https://www.diamonddotz.com/products/joy-to-the-world',
    srcImage: '/presets/angel-dress-src.jpg',
    resImage: '/presets/angel-dress-res.jpg',
  },
  {
    id: 'hummingbird-bloom',
    name: '动物主体·羽色分区',
    summary: '按羽毛天然分区贴钻、花朵逐瓣闭合成形、喙与花枝走一钻宽骨架链的花园路线。',
    prompt: withCommonRules(
      [
        'Convert the input photo into a bird-and-bloom rhinestone artwork with plumage patchwork:',
        '(1) The bird body is divided into its natural plumage patches (head, throat, breast, wing, tail); each patch becomes one flat closed field in its own bright color, and the patch edges are the artwork line work.',
        '(2) Each flower is drilled petal by petal: every petal is one closed flat shape, the flower center is one contrasting dot cluster.',
        '(3) Thin carriers — beak, stems, twigs — are single-gem-wide dot chains.',
        '(4) The soft background wash stays completely un-drilled; only bird and blooms sparkle.',
        'Suggested palette: 3-4 bright plumage colors + 1 bloom color + gold.',
      ].join('\n'),
    ),
    sourceNote:
      'Diamond Dotz Hummingbird Shadow Box 产品页（partial coverage 圆钻套装）: https://www.diamonddotz.com/products/hummingbird-shadow-box',
    srcImage: '/presets/hummingbird-bloom-src.jpg',
    resImage: '/presets/hummingbird-bloom-res.jpg',
  },
  {
    id: 'bear-plane',
    name: '英雄主体·细节点缀',
    summary: '大主体分件铺色，护目镜、横幅、小伙伴等趣味细节化作独立小钻簇，天空全留印。',
    prompt: withCommonRules(
      [
        'Convert the input photo into a hero-with-accents rhinestone artwork:',
        '(1) One hero machine-and-rider silhouette dominates: its body rebuilds as 2-3 big closed part-colored gem fields (fuselage, wings, rider body), colors taken from the subject itself.',
        '(2) Playful signature details — goggles, banner, small companion figures — become isolated accent clusters of 3-10 gems each, clearly separated from the main fields.',
        '(3) Motion parts (propeller, wheels) simplify to one dark silhouette field each; nothing hairline stays.',
        '(4) The entire open sky stays untouched: the design floats as one compact drilled island over flat print.',
        'Suggested palette: 2 subject body colors + 1 accent red + ivory-pearl + charcoal.',
      ].join('\n'),
    ),
    sourceNote:
      'Diamond Dotz Aero Bear 产品页（partial coverage 圆钻套装）: https://www.diamonddotz.com/products/aero-bear-diamond-painting-kit',
    srcImage: '/presets/bear-plane-src.jpg',
    resImage: '/presets/bear-plane-res.jpg',
  },
  {
    id: 'greeting-card',
    name: '贺卡小件·强对比简形',
    summary: '小尺寸路线：4-6 个大简形＋最强对比用色，粗体祝词可单色铺钻、细字留印。',
    prompt: withCommonRules(
      [
        'Convert the input photo into a small-format greeting-card rhinestone design:',
        '(1) Card scale demands boldness: one central festive motif rebuilt from at most 4-6 large simple closed shapes; anything that would need dots finer than a tenth of the motif height is merged into a bigger shape.',
        '(2) Silhouette first: the motif must read instantly at postcard size, with chunky outlines and high color contrast between adjacent shapes.',
        '(3) A greeting-word zone may sit above or below the motif: if the lettering is thick, drill it in one single color; thin script stays printed.',
        '(4) The card background stays flat and un-drilled except for a few optional single-gem sparkle dots scattered as frame accents.',
        'Suggested palette: 4-5 maximum-contrast colors.',
      ].join('\n'),
    ),
    sourceNote:
      'Heartful Diamonds Diamond Painting Christmas Greeting Card Set 产品页: https://heartfuldiamonds.com/products/new-diamond-painting-christmas-greeting-card-set',
    srcImage: '',
    resImage: '/presets/greeting-card-res.jpg',
  },
]
