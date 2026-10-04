/**
 * 导出双审计（add-flat-aux-segmentation T4.3 归属门 + T5.2 布局对齐抽样校验，
 * design D4/D5——2026-10-04）。两审计均为**披露不阻断**（v1 冻结：typed warning+
 * 明细留痕，Owner 可裁决升级为阻断），落点=task-export 门控管线（lint/mask/engine
 * 三门之后的第 [4] 道；warning 进 propose/execute 结果与导出工件元数据）。
 *
 * 正交意图：
 *   [1] auditLeafAttribution（T4.3 归属门——KB b35032e 同色粘连判据的程序化）：
 *       需求部位（v1=树上的语义节点集合——relation='semantic'，容器层 children 语义
 *       聚合；不引入外部需求清单解析）与产钻叶两面对照审计——
 *       (a) semantic-no-leaf：语义**容器**部位「无本叶」（本子树叶掩膜对其区域并集
 *           自覆盖 <10%——v5 产块=恒叶子，叶可徒有虚名）且其区域 ≥90% 被某**非本
 *           子树**产钻叶掩膜覆盖 → 该部位的钻会贴进邻层（归属错位）；
 *       (b) leaf-covered-by-leaf：产钻叶区域 ≥90% 被另一产钻叶覆盖（兄弟掩膜重叠
 *           的编辑残留——分件循环的兄弟消解只保证产树时互斥，树编辑/掩膜笔刷后
 *           可能重现）→ 双计/归属混淆。
 *   [2] auditLayoutAlignment（T5.2 布局对齐抽样校验）：终局 task-layout gems 投影
 *       回树掩膜域（同坐标系直查——task-layout grid.pixelsPerMm=tree.imagePx/
 *       canvasCm 换算，gem 坐标即树像素坐标）随机抽样 N=200 锚点，检查落点在本
 *       blockId 掩膜内或容差邻域（策略期 validateGemPlacement 保中心在膜内——
 *       导出期失败=layout 与树漂移/生成器缺陷的可观测信号）；异常率>5%=
 *       layout-alignment-suspicious warning 带样本明细。
 * 纯函数纪律：无 IO/无时钟；抽样确定性=种子化 LCG（同 seed 同样本——测试可回放）。
 */
import type { NodeBBox, ObjectTree } from '@handicraft/contracts';
import { nodeProducesBlock } from '@handicraft/contracts';

// ---------------------------------------------------------------- [1] 归属门（T4.3）

/** 归属门覆盖率阈值（KB b35032e 判据：部位区域 ≥90% 被邻层掩膜覆盖——冻结值）。 */
export const ATTRIBUTION_COVERAGE_THRESHOLD = 0.9;

/**
 * 「无本叶」自覆盖上限（部位子树的产钻叶掩膜对本区域的并集覆盖 <10%=无本叶——
 * 叶徒有虚名/区域由邻层持有的判据；产块语义=v5 恒叶子，故以自覆盖而非子树有无叶
 * 判定）。冻结值 0.1。
 */
export const ATTRIBUTION_OWN_COVERAGE_MAX = 0.1;

/** 节点 bbox 局部掩膜（node.mask 解析后——与 bbox 同维，行主序 0/1）。 */
export interface AuditNodeMask {
  nodeId: string;
  bbox: NodeBBox;
  w: number;
  h: number;
  bits: Uint8Array;
}

/** 归属缺口明细（attribution-gaps——部位/覆盖层/覆盖率/px 四元组+判别 kind）。 */
export interface AttributionGap {
  kind: 'semantic-no-leaf' | 'leaf-covered-by-leaf';
  nodeId: string;
  objectName: string;
  coveredByNodeId: string;
  coveredByObjectName: string;
  /** 覆盖率（overlapPx/regionPx——保留 4 位）。 */
  coverage: number;
  overlapPx: number;
  /** 部位区域置位像素数（bbox 局部掩膜 popcount）。 */
  regionPx: number;
}

function popcountOf(bits: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bits.length; i++) n += bits[i]! & 1;
  return n;
}

/** 两 bbox 局部掩膜重叠像素数（bbox 相交矩形内逐像素位与——无画布级展开，O(∩)。 */
function overlapPxOf(a: AuditNodeMask, b: AuditNodeMask): number {
  const x0 = Math.max(a.bbox.x, b.bbox.x);
  const y0 = Math.max(a.bbox.y, b.bbox.y);
  const x1 = Math.min(a.bbox.x + a.bbox.w, b.bbox.x + b.bbox.w);
  const y1 = Math.min(a.bbox.y + a.bbox.h, b.bbox.y + b.bbox.h);
  if (x1 <= x0 || y1 <= y0) return 0;
  let overlap = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const ia = (y - a.bbox.y) * a.w + (x - a.bbox.x);
      const ib = (y - b.bbox.y) * b.w + (x - b.bbox.x);
      if ((a.bits[ia]! & 1) === 1 && (b.bits[ib]! & 1) === 1) overlap++;
    }
  }
  return overlap;
}

/**
 * 叶子归属核对（纯函数）：树结构+逐节点 bbox 局部掩膜 → 归属缺口清单（确定性序=
 * 覆盖率降序→nodeId 字典序）。掩膜缺席/空区域的节点跳过（审计不炸——病态节点归
 * 主路径门）。
 * 产块语义对齐（contracts nodeProducesBlock=**恒叶子**，v5）：「无本叶」= 部位子树
 * 的叶掩膜对本区域自覆盖 <10%（叶可徒有虚名——区域实际由邻层持有）；部位自身是
 * 叶（自覆盖=1）恒健康。邻层=非本子树的产钻叶。
 */
export function auditLeafAttribution(input: {
  tree: ObjectTree;
  masks: ReadonlyMap<string, { bbox: NodeBBox; w: number; h: number; bits: Uint8Array }>;
  /** 覆盖率阈值（缺省 0.9——KB b35032e 判据冻结值；测试可覆写）。 */
  threshold?: number;
  /** 「无本叶」自覆盖上限（缺省 0.1——子树叶掩膜覆盖本区域 <10% 视为无本叶）。 */
  ownCoverageMax?: number;
}): AttributionGap[] {
  const threshold = input.threshold ?? ATTRIBUTION_COVERAGE_THRESHOLD;
  const ownCoverageMax = input.ownCoverageMax ?? ATTRIBUTION_OWN_COVERAGE_MAX;
  const byId = new Map(input.tree.nodes.map((node) => [node.id, node] as const));
  const productionLeaves = input.tree.nodes.filter((node) => nodeProducesBlock(node));
  const leafMaskOf = (nodeId: string): AuditNodeMask | null => {
    const node = byId.get(nodeId);
    const mask = input.masks.get(nodeId);
    if (node === undefined || mask === undefined) return null;
    return { nodeId, bbox: node.bbox, w: mask.w, h: mask.h, bits: mask.bits };
  };

  // 子树节点收集（含直接子节点——语义部位自覆盖并集用；叶=空集）
  const subtreeNodes = new Map<string, string[]>();
  const nodesUnder = (nodeId: string): string[] => {
    const hit = subtreeNodes.get(nodeId);
    if (hit !== undefined) return hit;
    const node = byId.get(nodeId);
    const result: string[] = [];
    if (node !== undefined) {
      for (const childId of node.children) {
        result.push(childId, ...nodesUnder(childId));
      }
    }
    subtreeNodes.set(nodeId, result);
    return result;
  };

  /** 部位区域被「本子树叶掩膜并集」覆盖的像素比例（Set 去重——重叠叶不双计）。 */
  const ownLeafCoverageOf = (nodeId: string, region: AuditNodeMask): number => {
    const regionPx = popcountOf(region.bits);
    if (regionPx === 0) return 1;
    const covered = new Set<number>();
    for (const descendantId of nodesUnder(nodeId)) {
      const node = byId.get(descendantId);
      if (node === undefined || !nodeProducesBlock(node)) continue;
      const own = leafMaskOf(descendantId);
      if (own === null) continue;
      const x0 = Math.max(region.bbox.x, own.bbox.x);
      const y0 = Math.max(region.bbox.y, own.bbox.y);
      const x1 = Math.min(region.bbox.x + region.bbox.w, own.bbox.x + own.bbox.w);
      const y1 = Math.min(region.bbox.y + region.bbox.h, own.bbox.y + own.bbox.h);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const ir = (y - region.bbox.y) * region.w + (x - region.bbox.x);
          const io = (y - own.bbox.y) * own.w + (x - own.bbox.x);
          if ((region.bits[ir]! & 1) === 1 && (own.bits[io]! & 1) === 1) covered.add(ir);
        }
      }
    }
    return covered.size / regionPx;
  };

  // 审计对象：(a) 语义**容器**节点（子树叶对本区域自覆盖 <10%=无本叶——叶自身
  //             自覆盖恒 1 不入此面；根/画布排除）；(b) 产钻叶（vs 其它产钻叶）。
  const candidates: Array<{ kind: AttributionGap['kind']; nodeId: string; objectName: string }> = [];
  for (const node of input.tree.nodes) {
    if (node.parent === null || node.category === 'canvas') continue;
    if (node.relation === 'semantic' && !nodeProducesBlock(node)) {
      candidates.push({ kind: 'semantic-no-leaf', nodeId: node.id, objectName: node.objectName });
    }
  }
  for (const leaf of productionLeaves) {
    candidates.push({ kind: 'leaf-covered-by-leaf', nodeId: leaf.id, objectName: leaf.objectName });
  }

  const gaps: AttributionGap[] = [];
  for (const candidate of candidates) {
    const region = leafMaskOf(candidate.nodeId);
    if (region === null || region.w * region.h !== region.bits.length) continue;
    const regionPx = popcountOf(region.bits);
    if (regionPx === 0) continue;
    if (candidate.kind === 'semantic-no-leaf' && ownLeafCoverageOf(candidate.nodeId, region) >= ownCoverageMax) {
      continue; // 有本叶（子树叶实际持有区域）——健康，不报
    }
    // 覆盖者=非本子树产钻叶（leaf-covered 面：叶无子树，其它叶恒非本子树）。
    const ownSubtree = new Set(nodesUnder(candidate.nodeId));
    let best: AttributionGap | null = null;
    for (const leaf of productionLeaves) {
      if (leaf.id === candidate.nodeId || ownSubtree.has(leaf.id)) continue;
      const cover = leafMaskOf(leaf.id);
      if (cover === null) continue;
      const overlapPx = overlapPxOf(region, cover);
      const coverage = overlapPx / regionPx;
      if (coverage >= threshold && (best === null || coverage > best.coverage)) {
        best = {
          kind: candidate.kind,
          nodeId: candidate.nodeId,
          objectName: candidate.objectName,
          coveredByNodeId: leaf.id,
          coveredByObjectName: leaf.objectName,
          coverage: Math.round(coverage * 10000) / 10000,
          overlapPx,
          regionPx,
        };
      }
    }
    if (best !== null) gaps.push(best);
  }
  gaps.sort((a, b) => (b.coverage !== a.coverage ? b.coverage - a.coverage : a.nodeId < b.nodeId ? -1 : 1));
  return gaps;
}

/** 归属缺口 → warning 文本（任务级披露——导出结果/帧流呈现面）。 */
export function attributionGapWarningText(gaps: readonly AttributionGap[]): string {
  const detail = gaps
    .slice(0, 5)
    .map(
      (gap) =>
        `${gap.kind === 'semantic-no-leaf' ? '语义部位' : '产钻叶'}「${gap.objectName}」(${gap.nodeId})`
        + ` ${(gap.coverage * 100).toFixed(1)}% 被「${gap.coveredByObjectName}」(${gap.coveredByNodeId}) 掩膜覆盖`
        + `（${gap.overlapPx}/${gap.regionPx}px${gap.kind === 'semantic-no-leaf' ? '，本叶缺席——该部位钻将贴进邻层' : '，兄弟重叠双计嫌疑'}）`,
    )
    .join('；');
  return (
    `attribution-gaps：${gaps.length} 处归属缺口（≥${ATTRIBUTION_COVERAGE_THRESHOLD * 100}% 被邻层掩膜覆盖）`
    + `——${detail}${gaps.length > 5 ? ` 等 ${gaps.length} 处` : ''}。`
    + 'v1 披露不阻断：请人工核对树归属（tree.reparent/refine 修正后重跑策略再导出）'
  );
}

// ---------------------------------------------------------------- [2] 对齐抽样（T5.2）

/** 抽样规模（design D5：N=200——冻结值；gems<200 时全量）。 */
export const ALIGNMENT_SAMPLE_SIZE = 200;
/** 锚点容差邻域半径（px——掩膜边界 ±2px 内不算异常：舍入/边界半钻位）。 */
export const ALIGNMENT_TOLERANCE_PX = 2;
/** 异常率阈（>5%=layout-alignment-suspicious——冻结值）。 */
export const ALIGNMENT_ANOMALY_RATE_MAX = 0.05;

/** 对齐审计异常样本。 */
export interface AlignmentAnomaly {
  gemId: string;
  blockId: string;
  x: number;
  y: number;
  reason: 'block-missing' | 'outside-mask';
  detail: string;
}

export interface AlignmentAuditReport {
  /** 实抽样数（=min(gems, 200)——gems=0 时 sampled=0 非可疑）。 */
  sampled: number;
  anomalies: AlignmentAnomaly[];
  /** 异常率（anomalies/sampled；sampled=0 时=0）。 */
  anomalyRate: number;
  suspicious: boolean;
}

/**
 * 种子化 LCG（确定性抽样——同 seed 同样本序；参数=Park–Miller 常数族）。
 */
function lcgNext(state: { seed: number }): number {
  state.seed = (state.seed * 48271) % 2147483647;
  return state.seed;
}

/**
 * 布局对齐抽样校验（纯函数）：gems 随机抽样 N=200（seed 化 LCG——确定性），逐锚点
 * 检查落点在本 blockId 掩膜内或容差邻域（±ALIGNMENT_TOLERANCE_PX 圆盘内任一掩膜
 * 像素）。异常率>5% → suspicious（调用方落 layout-alignment-suspicious warning）。
 * blocks=treeToBlocks 产块（bbox 局部掩膜）——与 gem 坐标同画布域（同坐标系直查）。
 */
export function auditLayoutAlignment(input: {
  gems: ReadonlyArray<{ id: string; x: number; y: number; blockId: string }>;
  blocks: ReadonlyArray<{ id: string; bbox: NodeBBox; mask: { w: number; h: number; bits: Uint8Array } }>;
  /** 抽样种子（缺省 1——同种子同样本，回放确定）。 */
  seed?: number;
  /** 抽样规模覆写（缺省 200；测试注入小值）。 */
  sampleSize?: number;
  /** 容差半径覆写（px；缺省 2）。 */
  tolerancePx?: number;
}): AlignmentAuditReport {
  const sampleSize = Math.min(input.sampleSize ?? ALIGNMENT_SAMPLE_SIZE, input.gems.length);
  if (sampleSize <= 0) return { sampled: 0, anomalies: [], anomalyRate: 0, suspicious: false };
  const tolerance = input.tolerancePx ?? ALIGNMENT_TOLERANCE_PX;

  // 确定性抽样：索引数组 Fisher–Yates 洗牌前 k 个（seed 化 LCG 驱动）。
  const indices = input.gems.map((_, i) => i);
  const state = { seed: Math.max(1, Math.trunc(input.seed ?? 1)) };
  for (let i = 0; i < sampleSize; i++) {
    const j = i + Math.floor(lcgNext(state) / 2147483647 * (indices.length - i));
    const tmp = indices[i]!;
    indices[i] = indices[j]!;
    indices[j] = tmp;
  }
  const sampled = indices.slice(0, sampleSize).map((i) => input.gems[i]!);

  const blockById = new Map(input.blocks.map((block) => [block.id, block] as const));
  const inMaskAt = (
    block: { bbox: NodeBBox; mask: { w: number; h: number; bits: Uint8Array } },
    x: number,
    y: number,
  ): boolean => {
    const ix = Math.round(x) - block.bbox.x;
    const iy = Math.round(y) - block.bbox.y;
    if (ix < 0 || iy < 0 || ix >= block.mask.w || iy >= block.mask.h) return false;
    return block.mask.bits[iy * block.mask.w + ix] === 1;
  };

  const anomalies: AlignmentAnomaly[] = [];
  for (const gem of sampled) {
    const block = blockById.get(gem.blockId);
    if (block === undefined) {
      anomalies.push({
        gemId: gem.id,
        blockId: gem.blockId,
        x: gem.x,
        y: gem.y,
        reason: 'block-missing',
        detail: `blockId ${gem.blockId} 不在当前树产块集（layout 与树漂移？）`,
      });
      continue;
    }
    if (inMaskAt(block, gem.x, gem.y)) continue;
    // 容差邻域：±tolerance 圆盘内任一掩膜像素（掩膜边界半钻位不算异常）
    let near = false;
    for (let dy = -tolerance; dy <= tolerance && !near; dy++) {
      for (let dx = -tolerance; dx <= tolerance && !near; dx++) {
        if (dx * dx + dy * dy > tolerance * tolerance) continue;
        if (inMaskAt(block, gem.x + dx, gem.y + dy)) near = true;
      }
    }
    if (near) continue;
    anomalies.push({
      gemId: gem.id,
      blockId: gem.blockId,
      x: gem.x,
      y: gem.y,
      reason: 'outside-mask',
      detail: `锚点 (${Math.round(gem.x)},${Math.round(gem.y)}) 落在 ${gem.blockId} 掩膜外 ${tolerance}px 容差邻域外`,
    });
  }
  const anomalyRate = anomalies.length / sampled.length;
  return {
    sampled: sampled.length,
    anomalies,
    anomalyRate: Math.round(anomalyRate * 10000) / 10000,
    suspicious: anomalyRate > ALIGNMENT_ANOMALY_RATE_MAX,
  };
}

/** 对齐审计 → warning 文本（可疑时——样本明细前 5 条）。 */
export function alignmentWarningText(report: AlignmentAuditReport): string {
  const detail = report.anomalies
    .slice(0, 5)
    .map((anomaly) => `${anomaly.gemId}[${anomaly.reason}] ${anomaly.detail}`)
    .join('；');
  return (
    `layout-alignment-suspicious：抽样 ${report.sampled} 颗锚点异常率 ${(report.anomalyRate * 100).toFixed(1)}%`
    + `（阈值 ${ALIGNMENT_ANOMALY_RATE_MAX * 100}%）——${detail}`
    + `${report.anomalies.length > 5 ? ` 等 ${report.anomalies.length} 条` : ''}。`
    + '布局与树掩膜可能漂移（task-layout 树锚 vs 当前树/掩膜编辑后未重跑策略？）——v1 披露不阻断，请核对后重跑策略再导出'
  );
}
