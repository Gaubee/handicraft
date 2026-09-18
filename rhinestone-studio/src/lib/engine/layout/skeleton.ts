/*
Orthogonal intents (max 2):
1. [2026-09-18 Algorithm] Zhang-Suen 细化（自实现，opencv.js 无 ximgproc——tech-research §2.1）：掩码 → 1px 骨架，linear 块的链化基底。
2. [2026-09-18 Chain] 骨架 → 像素链（端点/交叉点为节点，度 2 像素为链身；纯环单独处理），供等弧长取点。
*/

import type { Mask2D } from "../types";

/** Zhang-Suen 两子迭代细化，直到无删除。外部一律视为背景。 */
export function skeletonize(mask: Mask2D): Mask2D {
  const { w, h } = mask;
  const g = Uint8Array.from(mask.bits);
  const at = (x: number, y: number): number =>
    x >= 0 && y >= 0 && x < w && y < h ? g[y * w + x] : 0;

  const neighbors = (x: number, y: number): number[] => {
    // P2=N, P3=NE, P4=E, P5=SE, P6=S, P7=SW, P8=W, P9=NW
    return [
      at(x, y - 1),
      at(x + 1, y - 1),
      at(x + 1, y),
      at(x + 1, y + 1),
      at(x, y + 1),
      at(x - 1, y + 1),
      at(x - 1, y),
      at(x - 1, y - 1),
    ];
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (let sub = 0; sub < 2; sub++) {
      const del: number[] = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (g[y * w + x] !== 1) continue;
          const nb = neighbors(x, y);
          const B = nb.reduce((s, v) => s + v, 0);
          if (B < 2 || B > 6) continue;
          // A(P)：P2..P9 循环序列 0→1 跳变数
          let A = 0;
          for (let i = 0; i < 8; i++) {
            if (nb[i] === 0 && nb[(i + 1) % 8] === 1) A++;
          }
          if (A !== 1) continue;
          const [p2, , p4, , p6, , p8] = nb;
          if (sub === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }
          del.push(y * w + x);
        }
      }
      if (del.length > 0) {
        changed = true;
        for (const idx of del) g[idx] = 0;
      }
    }
  }
  return { w, h, bits: g };
}

export interface Pt {
  x: number;
  y: number;
}

/** 骨架 → 链列表（局部坐标像素中心序列；节点像素会被相邻链共享，等弧长后靠块内消解去重） */
export function skeletonChains(sk: Mask2D): Pt[][] {
  const { w, h, bits } = sk;
  const fg: number[] = [];
  for (let i = 0; i < bits.length; i++) if (bits[i] === 1) fg.push(i);
  if (fg.length === 0) return [];

  const DX = [-1, -1, 0, 1, 1, 1, 0, -1];
  const DY = [0, -1, -1, -1, 0, 1, 1, 1];
  const deg = new Int8Array(w * h);
  for (const i of fg) {
    const x = i % w;
    const y = Math.floor(i / w);
    let dgr = 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && bits[ny * w + nx] === 1) dgr++;
    }
    deg[i] = dgr;
  }

  const chains: Pt[][] = [];
  const visited = new Uint8Array(w * h);
  const nodes = fg.filter((i) => deg[i] !== 2); // 端点(1)/交叉(≥3)/孤立(0)
  const px = (i: number) => i % w;
  const py = (i: number) => Math.floor(i / w);

  const consumedEdges = new Set<number>(); // 节点-节点直连边（min*W*H+max 去重）

  for (const n of nodes) {
    if (deg[n] === 0) {
      chains.push([{ x: px(n), y: py(n) }]);
      continue;
    }
    const nx = px(n);
    const ny = py(n);
    for (let k = 0; k < 8; k++) {
      const mx = nx + DX[k];
      const my = ny + DY[k];
      if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
      const m = my * w + mx;
      if (bits[m] !== 1) continue;
      if (deg[m] !== 2) {
        // 节点-节点直连
        const key = Math.min(n, m) * w * h + Math.max(n, m);
        if (consumedEdges.has(key)) continue;
        consumedEdges.add(key);
        chains.push([
          { x: nx, y: ny },
          { x: mx, y: my },
        ]);
        continue;
      }
      if (visited[m]) continue;
      // 沿链身行走
      const chain: Pt[] = [{ x: nx, y: ny }];
      let prev = n;
      let cur = m;
      let guard = w * h;
      while (guard-- > 0) {
        chain.push({ x: px(cur), y: py(cur) });
        if (deg[cur] !== 2) break; // 到达节点
        visited[cur] = 1;
        let next = -1;
        const cx = px(cur);
        const cy = py(cur);
        for (let k2 = 0; k2 < 8; k2++) {
          const ax = cx + DX[k2];
          const ay = cy + DY[k2];
          if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue;
          const ai = ay * w + ax;
          if (bits[ai] === 1 && ai !== prev) {
            next = ai;
            break;
          }
        }
        if (next < 0 || visited[next]) break; // 回到已走链身（环闭）
        prev = cur;
        cur = next;
      }
      chains.push(chain);
    }
  }

  // 纯环（无任何节点）：从光栅序第一像素起单向走一圈
  if (nodes.length === 0) {
    const start = fg[0];
    const chain: Pt[] = [];
    let prev = -1;
    let cur = start;
    let guard = w * h;
    while (guard-- > 0) {
      chain.push({ x: px(cur), y: py(cur) });
      visited[cur] = 1;
      let next = -1;
      const cx = px(cur);
      const cy = py(cur);
      for (let k = 0; k < 8; k++) {
        const ax = cx + DX[k];
        const ay = cy + DY[k];
        if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue;
        const ai = ay * w + ax;
        if (bits[ai] === 1 && ai !== prev) {
          next = ai;
          break;
        }
      }
      if (next < 0 || next === start || visited[next]) break;
      prev = cur;
      cur = next;
    }
    chains.push(chain);
  }
  return chains;
}
