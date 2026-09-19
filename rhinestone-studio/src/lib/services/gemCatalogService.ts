/**
 * 钻目录 service（rename-and-expert-workbench S-4.1；design §4.2）。
 *
 * 定位：service = 无 UI 依赖的用例编排层；规格选择器（5.3）/ 校准向导（5.4）/
 * 笔刷当前 spec（5.5）一律只依赖本接口，不依赖实现。
 *
 * 真源分层（design §0.4 入库口径）：
 * - W0 前：内存 mock（ROUND_SS_BOOTSTRAP 派生 round × SS 十二档）——本文件
 *   `createInMemoryGemCatalogService`；
 * - W0 后（依赖轨 5.6 切换点 ⤵）：目录真源 = 素材库 sys-shapes `.gemshape` 资产
 *   （含内置形 seed）；engine 迁移 bootstrap 查表仅兜旧档，不是运行时真源。
 *   切换 = 替换实现（sys-shapes 资产 hydrate），**接口签名不变**；
 *   `CatalogSpec` 届时对齐 canonical `GemSpecSnapshot`（结构超集，赋值兼容）；
 *   mock 退役为 vitest 夹具（议题 2 裁决——不保留双实现并存）。
 *
 * specKey 确定性规则与 W0 一致：'round-ssXX'（engine spec.ts roundSpecKeyOfSs /
 * ROUND_SS_BOOTSTRAP 同源派生——身份不由显示码/浮点径反推）。
 */

import { ROUND_SS_BOOTSTRAP } from '$lib/engine'

/** W0 前本地最小目录条目结构（切换后对齐 GemSpecSnapshot——赋值兼容扩展）。 */
export interface CatalogSpec {
  /** canonical 身份键（'round-ss10'——确定性生成规则与 W0 specKey 一致） */
  specKey: string
  /** W0 前恒 'round' */
  shapeId: string
  /** 人读尺寸标签（'SS10'——不参与身份） */
  sizeLabel: string
  /** 名义直径 mm（SS_TABLE 派生） */
  diameterMm: number
}

/** 钻目录 service 接口（消费方只依赖本面；签名冻结——5.6 真源切换不改）。 */
export interface GemCatalogService {
  /** 全量规格清单（SS_KEYS 声明序）。 */
  listSpecs(): Promise<CatalogSpec[]>
  /** 按 specKey 解析；未知键返回 undefined。 */
  resolveSpec(specKey: string): Promise<CatalogSpec | undefined>
}

/**
 * 内存 mock（W0 前默认实现）：round × SS_KEYS 十二档自 ROUND_SS_BOOTSTRAP 派生。
 * 确定性/幂等：每次调用返回等值新数组（无内部可变态，调用方持有安全）。
 */
export function createInMemoryGemCatalogService(): GemCatalogService {
  const specs: readonly CatalogSpec[] = Object.freeze(
    ROUND_SS_BOOTSTRAP.map((row) => ({
      specKey: row.specKey,
      shapeId: 'round',
      sizeLabel: row.ss,
      diameterMm: row.diameterMm,
    })),
  )
  const byKey = new Map(specs.map((s) => [s.specKey, s]))
  return {
    async listSpecs(): Promise<CatalogSpec[]> {
      return specs.map((s) => ({ ...s }))
    },
    async resolveSpec(specKey: string): Promise<CatalogSpec | undefined> {
      const found = byKey.get(specKey)
      return found === undefined ? undefined : { ...found }
    },
  }
}
