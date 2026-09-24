/**
 * SS 云数据参考静态表（add-stone-library design §9.2——S6.2 消费位落地）。
 * 原始需求 2026-09-24（tasks.md S6.2）：库内无近邻时的跨体系替代候选——
 * 标注「云数据参考，非库存承诺」（Owner「之前建的只能当云数据」）。
 * 数据源：experiments/rhinestone-catalog-20260924/catalog.json（2026-09-24 研究稿，
 * 86 SKU——通用钻表七字段模型降级为云数据参考的裁定产物）。复制进 daemon，
 * 不跨仓引用（快照哲学：源目录演进不回写本表，升级=重新抄录+测试对拍）。
 * 抽取规则（三裁剪，登记偏差面）：
 *   [1] 仅取 sizeKind=ss 的 63 条——CloudCatalogEntry 契约（contracts 冻结）
 *       system 字面量 'ss' + label /^SS[0-9]+$/，异形 mm 尺寸条目（baguette/pear
 *       等 23 条）无承载面，归云数据建设另立（design §9.2「云数据建设另立」）。
 *   [2] 按 (label, color) 去重 63→53——同档同色的 cut 变体（maxima/molded）
 *       在 ΔE+尺寸替代语义下等价（rgb 取自色表，同色同值）。
 *   [3] diameterMm 一律取 contracts SS_DIAMETER_TABLE（ssSizeMm 同源）——源目录
 *       自带 consensus mm 有 ±0.1 漂移（SS16 3.9/SS20 4.7/SS34 7.0），不引入
 *       第二套换算真源；colorName 取色表中文名。
 */
import { SS_DIAMETER_TABLE, type CloudCatalogEntry, type SsKey } from '@handicraft/contracts';

/** SS 云数据参考条目（53 条——CloudCatalogEntry 契约形状，diameterMm 与 ssSizeMm 测试锁死）。 */
export const SS_CLOUD_CATALOG: readonly CloudCatalogEntry[] = [
  { system: 'ss', label: 'SS6', diameterMm: 2.0, colorName: '紫晶', rgb: [153, 102, 204] },
  { system: 'ss', label: 'SS6', diameterMm: 2.0, colorName: '浅黄绿', rgb: [181, 213, 60] },
  { system: 'ss', label: 'SS6', diameterMm: 2.0, colorName: '白钻（透明）', rgb: [247, 247, 252] },
  { system: 'ss', label: 'SS6', diameterMm: 2.0, colorName: '白钻AB', rgb: [229, 230, 240] },
  { system: 'ss', label: 'SS6', diameterMm: 2.0, colorName: '祖母绿', rgb: [0, 138, 84] },
  { system: 'ss', label: 'SS6', diameterMm: 2.0, colorName: '黑透', rgb: [26, 26, 26] },
  { system: 'ss', label: 'SS6', diameterMm: 2.0, colorName: '浅桃', rgb: [255, 218, 185] },
  { system: 'ss', label: 'SS6', diameterMm: 2.0, colorName: '浅粉', rgb: [255, 197, 203] },
  { system: 'ss', label: 'SS6', diameterMm: 2.0, colorName: '浅金香槟', rgb: [224, 193, 132] },
  { system: 'ss', label: 'SS6', diameterMm: 2.0, colorName: '深红（宝石红）', rgb: [155, 17, 30] },
  { system: 'ss', label: 'SS6', diameterMm: 2.0, colorName: '宝蓝', rgb: [15, 82, 186] },
  { system: 'ss', label: 'SS6', diameterMm: 2.0, colorName: '正红', rgb: [200, 16, 46] },
  { system: 'ss', label: 'SS10', diameterMm: 2.8, colorName: '紫晶', rgb: [153, 102, 204] },
  { system: 'ss', label: 'SS10', diameterMm: 2.8, colorName: '浅黄绿', rgb: [181, 213, 60] },
  { system: 'ss', label: 'SS10', diameterMm: 2.8, colorName: '白钻（透明）', rgb: [247, 247, 252] },
  { system: 'ss', label: 'SS10', diameterMm: 2.8, colorName: '白钻AB', rgb: [229, 230, 240] },
  { system: 'ss', label: 'SS10', diameterMm: 2.8, colorName: '祖母绿', rgb: [0, 138, 84] },
  { system: 'ss', label: 'SS10', diameterMm: 2.8, colorName: '黑透', rgb: [26, 26, 26] },
  { system: 'ss', label: 'SS10', diameterMm: 2.8, colorName: '浅桃', rgb: [255, 218, 185] },
  { system: 'ss', label: 'SS10', diameterMm: 2.8, colorName: '浅粉', rgb: [255, 197, 203] },
  { system: 'ss', label: 'SS10', diameterMm: 2.8, colorName: '浅金香槟', rgb: [224, 193, 132] },
  { system: 'ss', label: 'SS10', diameterMm: 2.8, colorName: '深红（宝石红）', rgb: [155, 17, 30] },
  { system: 'ss', label: 'SS10', diameterMm: 2.8, colorName: '宝蓝', rgb: [15, 82, 186] },
  { system: 'ss', label: 'SS10', diameterMm: 2.8, colorName: '正红', rgb: [200, 16, 46] },
  { system: 'ss', label: 'SS16', diameterMm: 4.0, colorName: '紫晶', rgb: [153, 102, 204] },
  { system: 'ss', label: 'SS16', diameterMm: 4.0, colorName: '浅黄绿', rgb: [181, 213, 60] },
  { system: 'ss', label: 'SS16', diameterMm: 4.0, colorName: '白钻（透明）', rgb: [247, 247, 252] },
  { system: 'ss', label: 'SS16', diameterMm: 4.0, colorName: '白钻AB', rgb: [229, 230, 240] },
  { system: 'ss', label: 'SS16', diameterMm: 4.0, colorName: '祖母绿', rgb: [0, 138, 84] },
  { system: 'ss', label: 'SS16', diameterMm: 4.0, colorName: '黑透', rgb: [26, 26, 26] },
  { system: 'ss', label: 'SS16', diameterMm: 4.0, colorName: '浅桃', rgb: [255, 218, 185] },
  { system: 'ss', label: 'SS16', diameterMm: 4.0, colorName: '浅粉', rgb: [255, 197, 203] },
  { system: 'ss', label: 'SS16', diameterMm: 4.0, colorName: '浅金香槟', rgb: [224, 193, 132] },
  { system: 'ss', label: 'SS16', diameterMm: 4.0, colorName: '深红（宝石红）', rgb: [155, 17, 30] },
  { system: 'ss', label: 'SS16', diameterMm: 4.0, colorName: '宝蓝', rgb: [15, 82, 186] },
  { system: 'ss', label: 'SS16', diameterMm: 4.0, colorName: '正红', rgb: [200, 16, 46] },
  { system: 'ss', label: 'SS20', diameterMm: 4.8, colorName: '紫晶', rgb: [153, 102, 204] },
  { system: 'ss', label: 'SS20', diameterMm: 4.8, colorName: '浅黄绿', rgb: [181, 213, 60] },
  { system: 'ss', label: 'SS20', diameterMm: 4.8, colorName: '白钻（透明）', rgb: [247, 247, 252] },
  { system: 'ss', label: 'SS20', diameterMm: 4.8, colorName: '白钻AB', rgb: [229, 230, 240] },
  { system: 'ss', label: 'SS20', diameterMm: 4.8, colorName: '祖母绿', rgb: [0, 138, 84] },
  { system: 'ss', label: 'SS20', diameterMm: 4.8, colorName: '黑透', rgb: [26, 26, 26] },
  { system: 'ss', label: 'SS20', diameterMm: 4.8, colorName: '浅桃', rgb: [255, 218, 185] },
  { system: 'ss', label: 'SS20', diameterMm: 4.8, colorName: '浅粉', rgb: [255, 197, 203] },
  { system: 'ss', label: 'SS20', diameterMm: 4.8, colorName: '浅金香槟', rgb: [224, 193, 132] },
  { system: 'ss', label: 'SS20', diameterMm: 4.8, colorName: '深红（宝石红）', rgb: [155, 17, 30] },
  { system: 'ss', label: 'SS20', diameterMm: 4.8, colorName: '宝蓝', rgb: [15, 82, 186] },
  { system: 'ss', label: 'SS20', diameterMm: 4.8, colorName: '正红', rgb: [200, 16, 46] },
  { system: 'ss', label: 'SS34', diameterMm: 7.1, colorName: '白钻（透明）', rgb: [247, 247, 252] },
  { system: 'ss', label: 'SS34', diameterMm: 7.1, colorName: '白钻AB', rgb: [229, 230, 240] },
  { system: 'ss', label: 'SS34', diameterMm: 7.1, colorName: '黑透', rgb: [26, 26, 26] },
  { system: 'ss', label: 'SS34', diameterMm: 7.1, colorName: '深红（宝石红）', rgb: [155, 17, 30] },
  { system: 'ss', label: 'SS34', diameterMm: 7.1, colorName: '宝蓝', rgb: [15, 82, 186] },
];

/** label 收窄为 SsKey 的档位视图（模块装载即校验闭集——抄录漂移启动期显式失败）。 */
export interface SsCatalogEntry extends Omit<CloudCatalogEntry, 'label'> {
  label: SsKey;
}

export const SS_CLOUD_CATALOG_SS: readonly SsCatalogEntry[] = SS_CLOUD_CATALOG.map((entry) => {
  if (!Object.hasOwn(SS_DIAMETER_TABLE, entry.label)) {
    throw new Error(`SS 云数据表含未知档位（SS_DIAMETER_TABLE 外——抄录漂移）：${entry.label}`);
  }
  return { ...entry, label: entry.label as SsKey };
});
