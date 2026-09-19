/*
Orthogonal intents (max 3):
1. [2026-09-18 Production] validate：spatial-hash（cell=pitch）全钻对间距检查（< pitch×0.999 → spacing warning）+ 孤岛检测（<3 钻的连通群 → island warning，tech-research §3.4 孤岛删除规则的前置报告）。
2. [2026-09-18 Contract] blocks 可选传入时补掩码越界（mask）检查；isExportable 供 UI 判定"带病禁导出"。
*/

import { effectiveSpecOf, maxCellPx, requiredCenterDistancePx } from "./geometry";
import { SpatialIndex } from "./ops";
import type { Block, Gem, GridSpec, Warning } from "./types";
import { GridSpecSchema } from "./types";

/**
 * 全量校验。确定性输出（按钻 id 稳定排序）。
 * spacing（tasks 1.2 混合径化）：任意两钻中心距 < requiredCenterDistancePx(a,b,grid)×0.999
 * （逐对圆包络判据 + v1 同口径浮点容差；等径圆钻 = v1 单一 pitch×0.999 判据逐位等价——
 * ENGINE_VERSION bump 护栏依据，design §2.1/§2.5）；
 * spatial hash cell = maxCellPx（tasks 1.1：混合径 3×3 邻域检索不漏；等径 = pitch）。
 * island：以 2.05×pitch 邻接做并查集，<3 钻的群（提示级，仍以基准 pitch 为邻域度量）。
 * mask：钻心不在所属块掩码内（blocks 传入时）。
 */
export function validate(gems: Gem[], grid: GridSpec, blocks?: Block[]): Warning[] {
  const g = GridSpecSchema.parse(grid);
  const pitch = g.pitchMm * g.pixelsPerMm;
  const warnings: Warning[] = [];

  // ---- spacing（spatial hash；cell = maxCellPx + 逐对圆包络判据——tasks 1.1/1.2） ----
  const specs = gems.map((gem) => effectiveSpecOf(gem, g));
  /** 逐对判距：圆包络 × v1 同口径 0.999 相对容差。 */
  const requiredOfPair = (i: number, j: number): number =>
    requiredCenterDistancePx(specs[i], specs[j], g) * 0.999;
  const index = new SpatialIndex<number>(maxCellPx(specs, g));
  gems.forEach((gem, i) => index.insert(gem.x, gem.y, i));
  const seenPairs = new Set<number>();
  for (let i = 0; i < gems.length; i++) {
    for (const j of index.query(gems[i].x, gems[i].y)) {
      if (j <= i) continue;
      const dx = gems[j].x - gems[i].x;
      const dy = gems[j].y - gems[i].y;
      const threshold = requiredOfPair(i, j);
      if (dx * dx + dy * dy >= threshold * threshold) continue;
      const key = i * gems.length + j;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const d = Math.sqrt(dx * dx + dy * dy);
      warnings.push({
        kind: "spacing",
        detail: `钻 ${gems[i].id} 与 ${gems[j].id} 中心距 ${d.toFixed(2)}px < 所需 ${threshold.toFixed(2)}px`,
      });
    }
  }

  // ---- island（并查集，2.05×pitch 邻接） ----
  const parent = new Int32Array(gems.length).map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const islandIdx = new SpatialIndex<number>(pitch * 2.05);
  gems.forEach((gem, i) => islandIdx.insert(gem.x, gem.y, i));
  const r2 = (pitch * 2.05) ** 2;
  for (let i = 0; i < gems.length; i++) {
    for (const j of islandIdx.query(gems[i].x, gems[i].y)) {
      if (j <= i) continue;
      const dx = gems[j].x - gems[i].x;
      const dy = gems[j].y - gems[i].y;
      if (dx * dx + dy * dy <= r2) union(i, j);
    }
  }
  const clusterSize = new Map<number, number>();
  for (let i = 0; i < gems.length; i++) {
    const r = find(i);
    clusterSize.set(r, (clusterSize.get(r) ?? 0) + 1);
  }
  for (let i = 0; i < gems.length; i++) {
    const r = find(i);
    if ((clusterSize.get(r) ?? 0) < 3 && r === i) {
      const members: string[] = [];
      for (let j = 0; j < gems.length; j++) if (find(j) === r) members.push(gems[j].id);
      warnings.push({ kind: "island", detail: `孤立钻组(<3)：${members.join(",")}` });
    }
  }

  // ---- mask（钻心在所属块掩码内） ----
  if (blocks) {
    const byId = new Map(blocks.map((b) => [b.id, b] as const));
    for (const gem of gems) {
      const block = byId.get(gem.blockId);
      if (!block) {
        warnings.push({ kind: "mask", detail: `钻 ${gem.id} 引用不存在的块 ${gem.blockId}` });
        continue;
      }
      const ix = Math.round(gem.x) - block.bbox.x;
      const iy = Math.round(gem.y) - block.bbox.y;
      const inside =
        ix >= 0 &&
        iy >= 0 &&
        ix < block.bbox.w &&
        iy < block.bbox.h &&
        block.mask.bits[iy * block.bbox.w + ix] === 1;
      if (!inside) {
        warnings.push({ kind: "mask", detail: `钻 ${gem.id} 中心 (${gem.x.toFixed(1)},${gem.y.toFixed(1)}) 越出块 ${block.id} 掩码` });
      }
    }
  }

  return warnings;
}

/** 有 spacing 或 mask 违规 → 禁止导出（不变量 5；spec「排布硬约束」：间距与钻心在掩码内均为硬约束） */
export function isExportable(warnings: Warning[]): boolean {
  return !warnings.some((w) => w.kind === "spacing" || w.kind === "mask");
}
