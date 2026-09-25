/**
 * object-tree 树视图叠加预览图（add-subject-sam-pipeline tasks P0.4 / design §1 S5
 * ——「人看图+机用工件双轨」的图轨）。
 * 原始需求 2026-09-24（Owner：输出留存可审查）：原图+节点 bbox 框+序号角标 → PNG。
 * 零字体依赖（P0.4 约束）：文字=3×5 位图数字字库（纯几何，最简位图路线）——图上只画
 * 「框+序号」，名称/尺寸/判据对照走工件 JSON 的序号↔节点表（tree-persist 规范序）。
 * 正交意图：
 *   [1] renderTreeOverlayPreview：RGBA 平面叠加——drillWorthy 节点绿系框（父子层级
 *       用框色深浅）、排除节点红框；角标序号=节点数组序（1 基）。
 *   [2] 位图数字字库（0-9，3×5 单色）+角标牌绘制（黑底白字，任意底图可读）。
 */
import type { NodeBBox, ObjectTree } from '@handicraft/contracts';
import { encodePng } from '../../png/codec.js';

/** 框线粗（px）——80px 量级小图与千像素大图均可见的最小值。 */
export const FRAME_STROKE_PX = 2;

/** drillWorthy 框色（父子层级=深浅：depth 0 最亮，逐层压暗；RGB）。 */
const DRILL_WORTHY_GREENS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 255, 0],
  [0, 190, 0],
  [0, 140, 0],
  [0, 100, 0],
];

/** 排除节点框色（红——与绿系钻赏框在色相上远隔，人眼/像素检测双友好）。 */
const EXCLUDED_RED: readonly [number, number, number] = [255, 0, 0];

/** 3×5 位图数字字库（行主序字符串，'1'=亮像素——最简位图字库，非字体依赖）。 */
const DIGIT_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

/** 位图数字缩放（×2——3×5 → 6×10，80px 图上仍可辨认）。 */
const DIGIT_SCALE = 2;
/** 角标牌内边距（px，四周）。 */
const PLAQUE_PAD = 2;

/** 叠加底图（codec 解码面：RGBA8 平面——decodePng 产物同形）。 */
export interface TreePreviewImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** 序号↔节点对照条目（预览图角标序号 → 工件 JSON 节点的桥——人看图双轨）。 */
export interface TreePreviewLegendEntry {
  /** 角标序号（1 基=nodes 数组序；持久化 DFS 规范序下=树先序） */
  seq: number;
  nodeId: string;
  objectName: string;
  category: string;
  drillWorthy: boolean;
  /** 树深度（根=0——框色深浅的依据） */
  depth: number;
  bbox: NodeBBox;
  effectiveMm: number;
  labVariance: number;
}

export interface TreePreviewResult {
  /** PNG 字节（RGBA8 非隔行——codec 编码面） */
  png: Uint8Array;
  /** 全部绘制节点的对照表（含排除节点——图/JSON 各自可核对） */
  legend: TreePreviewLegendEntry[];
}

/** 节点深度（根=0；父链上溯——schema 已保证无环/根唯一）。 */
function depthMapOf(tree: ObjectTree): Map<string, number> {
  const depthOfNode = new Map<string, number>();
  const byId = new Map(tree.nodes.map((n) => [n.id, n] as const));
  for (const node of tree.nodes) {
    let depth = 0;
    let cur = node;
    while (cur.parent !== null) {
      depth++;
      const parent = byId.get(cur.parent);
      if (parent === undefined) break; // schema superRefine 已拒——防御性兜底
      cur = parent;
    }
    depthOfNode.set(node.id, depth);
  }
  return depthOfNode;
}

function setPixel(
  out: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  color: readonly [number, number, number],
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return; // 越界裁剪（bbox 可抵边）
  const p = (y * width + x) * 4;
  out[p] = color[0];
  out[p + 1] = color[1];
  out[p + 2] = color[2];
  out[p + 3] = 255; // 框/牌不透明——底图透明区也可见
}

/** bbox 周界描框（粗 FRAME_STROKE_PX；贴边 bbox 由 setPixel 裁剪）。 */
function strokeRect(
  out: Uint8Array,
  width: number,
  height: number,
  bbox: NodeBBox,
  color: readonly [number, number, number],
): void {
  const x0 = bbox.x;
  const y0 = bbox.y;
  const x1 = bbox.x + bbox.w - 1;
  const y1 = bbox.y + bbox.h - 1;
  for (let i = 0; i < FRAME_STROKE_PX; i++) {
    for (let x = x0; x <= x1; x++) {
      setPixel(out, width, height, x, y0 + i, color);
      setPixel(out, width, height, x, y1 - i, color);
    }
    for (let y = y0; y <= y1; y++) {
      setPixel(out, width, height, x0 + i, y, color);
      setPixel(out, width, height, x1 - i, y, color);
    }
  }
}

/** 数字位图尺寸（无字间空隙版宽=Σ3，高=5；再乘缩放）。 */
function digitSize(digits: string): { w: number; h: number } {
  return { w: digits.length * 3 * DIGIT_SCALE, h: 5 * DIGIT_SCALE };
}

/** 角标牌：黑底白字数字（左上角锚定——任意底图可读；越界由 setPixel 裁剪）。 */
function drawPlaque(
  out: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  seq: number,
): void {
  const digits = String(seq);
  const glyph = digitSize(digits);
  const plaqueW = glyph.w + PLAQUE_PAD * 2;
  const plaqueH = glyph.h + PLAQUE_PAD * 2;
  for (let dy = 0; dy < plaqueH; dy++) {
    for (let dx = 0; dx < plaqueW; dx++) {
      setPixel(out, width, height, x + dx, y + dy, [0, 0, 0]);
    }
  }
  const white: readonly [number, number, number] = [255, 255, 255];
  for (let i = 0; i < digits.length; i++) {
    const rows = DIGIT_GLYPHS[digits[i]!];
    for (let gy = 0; gy < rows.length; gy++) {
      const row = rows[gy]!;
      for (let gx = 0; gx < row.length; gx++) {
        if (row[gx] !== '1') continue;
        for (let sy = 0; sy < DIGIT_SCALE; sy++) {
          for (let sx = 0; sx < DIGIT_SCALE; sx++) {
            const px =
              x + PLAQUE_PAD + (i * 3 + gx) * DIGIT_SCALE + sx;
            const py = y + PLAQUE_PAD + gy * DIGIT_SCALE + sy;
            setPixel(out, width, height, px, py, white);
          }
        }
      }
    }
  }
}

/**
 * 树视图叠加预览（纯函数——同图同树同 PNG，审计可回放）。
 * 绘制序=nodes 数组序（先父后子——子框压父框之上；角标牌最后画保可读）。
 * 序号=数组序+1：持久化（tree-persist）以 DFS 规范序落盘，故图上序号即 JSON
 * 节点序——「图（框+序号）+JSON（序号→名称/尺寸/判据）」双轨对齐。
 */
export function renderTreeOverlayPreview(image: TreePreviewImage, tree: ObjectTree): TreePreviewResult {
  if (image.rgba.byteLength !== image.width * image.height * 4) {
    throw new RangeError(
      `像素面长度 ${image.rgba.byteLength} ≠ ${image.width}×${image.height}×4`,
    );
  }
  const out = new Uint8Array(image.rgba); // 不改底图（纯函数纪律）
  const depths = depthMapOf(tree);

  for (const node of tree.nodes) {
    const color = node.drillWorthy
      ? (DRILL_WORTHY_GREENS[Math.min(depths.get(node.id) ?? 0, DRILL_WORTHY_GREENS.length - 1)]!)
      : EXCLUDED_RED;
    strokeRect(out, image.width, image.height, node.bbox, color);
  }
  const legend: TreePreviewLegendEntry[] = tree.nodes.map((node, i) => ({
    seq: i + 1,
    nodeId: node.id,
    objectName: node.objectName,
    category: node.category,
    drillWorthy: node.drillWorthy,
    depth: depths.get(node.id) ?? 0,
    bbox: node.bbox,
    effectiveMm: node.effectiveMm,
    labVariance: node.labVariance,
  }));
  // 角标牌最后统一画（盖在框线上，不被后画的框线切碎）。
  tree.nodes.forEach((node, i) => {
    drawPlaque(out, image.width, image.height, node.bbox.x + 1, node.bbox.y + 1, i + 1);
  });

  return { png: encodePng(image.width, image.height, out), legend };
}
