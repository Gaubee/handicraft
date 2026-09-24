/**
 * 生产组合契约（add-stone-library design §7.1——S7.1 冻结）。
 * 原始需求 2026-09-24（Owner 补充定调四原话冻结）：「第二步是关于生产管理，就是
 * 生产的时候我们可以把某些标准的部分钻或全部钻集合起来，形成新的一种组合，
 * 利用这种组合去做生产。」
 * 引用集不变量（语义骨架——service/工具面/测试共同遵守）：
 *   - 成员只存 stoneRef（标准原子 resourceId，**弱引用**）——标准库改贴图/颜色/
 *     尺寸，组合读时解析自动跟随（零同步机制）；组合**永不内嵌**贴图或 stone
 *     字段副本（strict schema 即证明面：成员多一个键都拒）。
 *   - 成员缺失=显式 missing 态（四态同 §1.6 引用保护：resolved/soft-deleted/
 *     blob-missing/wrong-kind；行不存在=not-found 第五态）——**不自动剔除**。
 *   - quantity 是备料参考（缺省=「按设计用量另计」），非库存承诺。
 * 正交意图：
 *   [1] set.json 组合文件格式（§7.1 schema 冻结——与 stone.json 同纪律 strict）。
 *   [2] 限定名解析纯函数 qualifiedSku（§7.6 编号冲突区分——展示投影，不落存储）。
 */
import { z } from 'zod';
import { IsoDateTimeSchema } from './common.js';

// ---------------------------------------------------------------- §7.1 set.json

/** 组合成员=对标准原子的弱引用（永不内嵌 stone 数据副本——strict 即不变量）。 */
export const ProductionSetMemberSchema = z
  .object({
    /** 标准原子 resourceId（全局唯一 UUID——存储永不冲突）。 */
    stoneRef: z.string().min(1),
    /** 备料参考数量（正整数；缺省=按设计用量另计）。 */
    quantity: z.number().int().positive().optional(),
    /** 成员备注。 */
    note: z.string().optional(),
  })
  .strict();
export type ProductionSetMember = z.infer<typeof ProductionSetMemberSchema>;

/** 来源场景（§7.4 三来源：人工挑拣/BOM 反推/clone 复用）。 */
export const ProductionSetOriginSchema = z
  .object({
    kind: z.enum(['manual-pick', 'bom-derived', 'clone']),
    /** bom-derived：排钻任务/导出溯源（依赖内核 P3——落地前该来源不可用）。 */
    sourceTaskId: z.string().min(1).optional(),
    /** clone：母组合 set 目录行 resourceId。 */
    fromSetId: z.string().min(1).optional(),
  })
  .strict();
export type ProductionSetOrigin = z.infer<typeof ProductionSetOriginSchema>;

/**
 * set.json 文件格式（组合=一个目录 + set.json 文件行，blob 内容寻址同 stone.json）。
 * schema 与 design §7.1 逐字面一致（冻结）；origin 字段间的完整性（clone 须带
 * fromSetId 等）归 daemon 服务层校验——schema 层不收紧，保持冻结面。
 */
export const ProductionSetFileSchema = z
  .object({
    kind: z.literal('stone-set'),
    formatVersion: z.literal(1),
    /** 'set-' + uuid。 */
    id: z.string().min(1),
    /** '卡通人物套餐-A'。 */
    name: z.string().min(1),
    /** 用途（'小件卡通订单'）。 */
    purpose: z.string().optional(),
    /** 成员=引用集（min 1：空组合无生产语义——删空即删组合）。 */
    stones: z.array(ProductionSetMemberSchema).min(1),
    origin: ProductionSetOriginSchema,
    /** 自由扩展（同 stone 纪律——唯一自由扩展面）。 */
    metadata: z.record(z.string(), z.unknown()),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type ProductionSetFile = z.infer<typeof ProductionSetFileSchema>;

// ---------------------------------------------------------------- §7.6 限定名

/**
 * 限定名 `<标准ID>/<SKU>`（Owner 定调五：「编号可能冲突，自动加入标准 ID」——
 * `yuhang/J51` vs `factoryB/J51`）。
 * **展示投影，不落存储**：服务端解析成员时回填（标准改名自动跟随）；'/' 是
 * 分隔符——任一段含 '/' 即歧义，显式拒绝（不猜测转义）。
 */
export function qualifiedSku(supplier: string, sku: string): string {
  if (supplier.length === 0 || sku.length === 0 || supplier.includes('/') || sku.includes('/')) {
    throw new Error(
      `限定名不可生成（标准ID/SKU 须非空且不含 '/'）：supplier=${JSON.stringify(supplier)} sku=${JSON.stringify(sku)}`,
    );
  }
  return `${supplier}/${sku}`;
}
