/**
 * 系统 CJK 字体栅格化（导出矩阵 2026-10-02——numbered.png 图例「款名」的中文面，
 * 最佳努力降级）。服务端无 canvas/字体栈且**禁止新增原生依赖**（codec/render 纯 TS
 * 纪律同源），故实现最小 TrueType（glyf 轮廓）解析+扫描线栅格：
 *   - 惰性单例：按候选路径表尝试系统字体（macOS STHeiti/Songti/Arial Unicode 为
 *     glyf 轮廓实证可用；CFF 轮廓字体（Hiragino/Noto CJK OTF）无 glyf 表→跳过），
 *     HOLE_SHEET_CJK_FONT 环境变量优先（Linux 部署注入点）。
 *   - 随机访问（readSync@offset——55MB 字体文件绝不整读）。
 *   - cmap（format 4 BMP / format 12）→ glyf 简单字形+复合字形（2×2 仿射递归，
 *     点配位组件不支持=bail 降级）→ 二次贝塞尔（隐含中点控制点）展平 → even-odd
 *     扫描线 3×3 超采样 coverage。
 *   - 任何失败（无字体/未收录/截断/轮廓腐蚀）=null——调用方降级空心方框占位
 *     （bitmap-font drawFallbackBox）。**编号/stoneRef/颗数全 ASCII 点阵渲染，
 *     不依赖本模块**——生产语义载荷零系统依赖。
 */
import { closeSync, openSync, readSync } from 'node:fs';

/** 候选系统字体（glyf 轮廓 TrueType——CFF 字体无 glyf 表自动跳过）。 */
const FONT_CANDIDATES = [
  process.env['HOLE_SHEET_CJK_FONT'], // Linux 部署注入点（先于系统表）
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/System/Library/Fonts/Supplemental/Songti.ttc',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
].filter((p): p is string => typeof p === 'string' && p.length > 0);

interface SfntFont {
  fd: number;
  path: string;
  unitsPerEm: number;
  indexToLocFormat: number;
  numGlyphs: number;
  glyf: { offset: number; length: number };
  loca: { offset: number; length: number };
  cmap: { offset: number; length: number; format: number };
  hmtx: { offset: number; numberOfHMetrics: number };
}

interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

function compose(outer: Matrix, inner: Matrix): Matrix {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

// ---------------------------------------------------------------- 惰性单例

let cachedFont: SfntFont | null | undefined; // undefined=未尝试；null=无可用字体（终态，不再重试）

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done);
    if (n <= 0) throw new Error('font read EOF');
    done += n;
  }
  return buf;
}

function parseSfnt(path: string): SfntFont | null {
  const fd = openSync(path, 'r');
  try {
    // ttcf 集合取首个成员字体；单 sfnt 直接解析。
    const head12 = readAt(fd, 0, 12);
    let base = 0;
    if (head12.subarray(0, 4).toString('latin1') === 'ttcf') {
      base = readAt(fd, 12, 4).readUInt32BE(0);
    } else if (head12.readUInt32BE(0) !== 0x00010000 && head12.subarray(0, 4).toString('latin1') !== 'true') {
      return null; // CFF ('OTTO') 或未知容器——本栅格只吃 glyf 轮廓
    }
    const numTables = readAt(fd, base + 4, 2).readUInt16BE(0);
    const records = readAt(fd, base + 12, numTables * 16);
    const tables = new Map<string, { offset: number; length: number }>();
    for (let i = 0; i < numTables; i++) {
      const tag = records.subarray(i * 16, i * 16 + 4).toString('latin1');
      tables.set(tag, { offset: records.readUInt32BE(i * 16 + 8), length: records.readUInt32BE(i * 16 + 12) });
    }
    const glyf = tables.get('glyf');
    const loca = tables.get('loca');
    const cmapTable = tables.get('cmap');
    const headTable = tables.get('head');
    const maxp = tables.get('maxp');
    const hhea = tables.get('hhea');
    const hmtxTable = tables.get('hmtx');
    if (!glyf || !loca || !cmapTable || !headTable || !maxp || !hhea || !hmtxTable) return null;
    const head = readAt(fd, headTable.offset, 54);
    const unitsPerEm = head.readUInt16BE(18);
    const indexToLocFormat = head.readInt16BE(50);
    if (unitsPerEm === 0) return null;
    const numGlyphs = readAt(fd, maxp.offset + 4, 2).readUInt16BE(0);
    // cmap：优先 (3,1)/(3,10)/(0,x)/(3,0) 子表；仅支持 format 4/12。
    const cmapHeader = readAt(fd, cmapTable.offset, 4 + 8 * 0); // 先读计数
    const numSub = cmapHeader.readUInt16BE(2);
    const subRecords = readAt(fd, cmapTable.offset + 4, numSub * 8);
    let chosen: { offset: number; format: number } | null = null;
    let chosenRank = -1;
    for (let i = 0; i < numSub; i++) {
      const platformId = subRecords.readUInt16BE(i * 8);
      const encodingId = subRecords.readUInt16BE(i * 8 + 2);
      const subOffset = cmapTable.offset + subRecords.readUInt32BE(i * 8 + 4);
      const rank =
        platformId === 3 && encodingId === 10 ? 4
        : platformId === 3 && encodingId === 1 ? 3
        : platformId === 0 ? 2
        : platformId === 3 && encodingId === 0 ? 1
        : 0;
      if (rank === 0 || rank <= chosenRank) continue;
      const format = readAt(fd, subOffset, 2).readUInt16BE(0);
      if (format !== 4 && format !== 12) continue;
      chosen = { offset: subOffset, format };
      chosenRank = rank;
    }
    if (chosen === null) return null;
    return {
      fd,
      path,
      unitsPerEm,
      indexToLocFormat,
      numGlyphs,
      glyf,
      loca,
      cmap: { offset: chosen.offset, length: cmapTable.length, format: chosen.format },
      hmtx: { offset: hmtxTable.offset, numberOfHMetrics: readAt(fd, hhea.offset + 34, 2).readUInt16BE(0) },
    };
  } catch {
    return null;
  }
}

function loadFont(): SfntFont | null {
  if (cachedFont !== undefined) return cachedFont;
  for (const path of FONT_CANDIDATES) {
    let parsed: SfntFont | null = null;
    try {
      parsed = parseSfnt(path);
    } catch {
      parsed = null;
    }
    if (parsed !== null) {
      cachedFont = parsed;
      return cachedFont;
    }
  }
  cachedFont = null;
  return null;
}

// ---------------------------------------------------------------- cmap 查找

function cmapLookup(font: SfntFont, code: number): number {
  try {
    if (font.cmap.format === 4) {
      const header = readAt(font.fd, font.cmap.offset, 16);
      const segCount = header.readUInt16BE(6) / 2;
      const arrays = readAt(font.fd, font.cmap.offset + 14, segCount * 8 + 2);
      const endCodes = arrays.subarray(0, segCount * 2);
      const startCodes = arrays.subarray(segCount * 2 + 2, segCount * 4 + 2);
      const idDelta = arrays.subarray(segCount * 4 + 2, segCount * 6 + 2);
      const idRange = arrays.subarray(segCount * 6 + 2, segCount * 8 + 2);
      for (let i = 0; i < segCount; i++) {
        const end = endCodes.readUInt16BE(i * 2);
        if (code > end) continue;
        const start = startCodes.readUInt16BE(i * 2);
        if (code < start) return 0;
        const rangeOffset = idRange.readUInt16BE(i * 2);
        if (rangeOffset === 0) {
          return (((code + idDelta.readInt16BE(i * 2)) & 0xffff) >>> 0);
        }
        // glyphIdArray 寻址：&idRangeOffset[i] + rangeOffset + 2*(code-start)
        const address = font.cmap.offset + 14 + segCount * 6 + 2 + i * 2 + rangeOffset + (code - start) * 2;
        const glyphId = readAt(font.fd, address, 2).readUInt16BE(0);
        if (glyphId === 0) return 0;
        return (((glyphId + idDelta.readInt16BE(i * 2)) & 0xffff) >>> 0);
      }
      return 0;
    }
    // format 12
    const nGroups = readAt(font.fd, font.cmap.offset + 12, 4).readUInt32BE(0);
    const groups = readAt(font.fd, font.cmap.offset + 16, nGroups * 12);
    for (let i = 0; i < nGroups; i++) {
      const start = groups.readUInt32BE(i * 12);
      const end = groups.readUInt32BE(i * 12 + 4);
      if (code >= start && code <= end) {
        return groups.readUInt32BE(i * 12 + 8) + (code - start);
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- glyf 轮廓

interface ContourPoint {
  x: number;
  y: number;
  on: boolean;
}

function glyphRange(font: SfntFont, gid: number): { start: number; end: number } | null {
  if (gid >= font.numGlyphs) return null;
  try {
    if (font.indexToLocFormat === 0) {
      const pair = readAt(font.fd, font.loca.offset + gid * 2, 4);
      return { start: pair.readUInt16BE(0) * 2, end: pair.readUInt16BE(2) * 2 };
    }
    const pair = readAt(font.fd, font.loca.offset + gid * 4, 8);
    return { start: pair.readUInt32BE(0), end: pair.readUInt32BE(4) };
  } catch {
    return null;
  }
}

/** 字形轮廓点集（font units，y-up；多轮廓；复合字形递归展平）。null=不可解析。 */
function glyphContours(font: SfntFont, gid: number, m: Matrix, depth: number): ContourPoint[][] | null {
  if (depth > 6) return null; // 复合递归护栏
  const range = glyphRange(font, gid);
  if (range === null || range.end <= range.start) return null;
  try {
    const data = readAt(font.fd, font.glyf.offset + range.start, range.end - range.start);
    const numContours = data.readInt16BE(0);
    if (numContours >= 0) {
      // —— 简单字形
      if (numContours === 0) return null;
      const endPts: number[] = [];
      for (let i = 0; i < numContours; i++) endPts.push(data.readUInt16BE(10 + i * 2));
      const numPoints = (endPts[endPts.length - 1] ?? -1) + 1;
      if (numPoints <= 0 || numPoints > 65536) return null;
      let cursor = 10 + numContours * 2;
      const instructionLength = data.readUInt16BE(cursor);
      cursor += 2 + instructionLength;
      const flags: number[] = [];
      while (flags.length < numPoints) {
        const flag = data.readUInt8(cursor);
        cursor += 1;
        flags.push(flag);
        if (flag & 0x08) {
          const repeat = data.readUInt8(cursor);
          cursor += 1;
          for (let r = 0; r < repeat && flags.length < numPoints; r++) flags.push(flag);
        }
      }
      let x = 0;
      let y = 0;
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < numPoints; i++) {
        const flag = flags[i]!;
        if (flag & 0x02) {
          const d = data.readUInt8(cursor);
          cursor += 1;
          x += flag & 0x10 ? d : -d;
        } else if (!(flag & 0x10)) {
          x += data.readInt16BE(cursor);
          cursor += 2;
        }
        xs.push(x);
      }
      for (let i = 0; i < numPoints; i++) {
        const flag = flags[i]!;
        if (flag & 0x04) {
          const d = data.readUInt8(cursor);
          cursor += 1;
          y += flag & 0x20 ? d : -d;
        } else if (!(flag & 0x20)) {
          y += data.readInt16BE(cursor);
          cursor += 2;
        }
        ys.push(y);
      }
      const contours: ContourPoint[][] = [];
      let from = 0;
      for (const endPt of endPts) {
        const pts: ContourPoint[] = [];
        for (let i = from; i <= endPt && i < numPoints; i++) {
          const [tx, ty] = apply(m, xs[i]!, ys[i]!);
          pts.push({ x: tx, y: ty, on: (flags[i]! & 0x01) !== 0 });
        }
        contours.push(pts);
        from = endPt + 1;
      }
      return contours;
    }
    // —— 复合字形（components 递归；点配位 ARGS 不支持=bail）
    let offset = 10;
    let merged: ContourPoint[][] = [];
    for (;;) {
      const flags = data.readUInt16BE(offset);
      const componentGid = data.readUInt16BE(offset + 2);
      offset += 4;
      let arg1: number;
      let arg2: number;
      if (flags & 0x0001) {
        arg1 = data.readInt16BE(offset);
        arg2 = data.readInt16BE(offset + 2);
        offset += 4;
      } else {
        arg1 = data.readInt8(offset);
        arg2 = data.readInt8(offset + 1);
        offset += 2;
      }
      if (!(flags & 0x0002)) return null; // 点配位（point matching）不支持
      let local = IDENTITY;
      if (flags & 0x0008) {
        const s = data.readInt16BE(offset) / 16384;
        offset += 2;
        local = { a: s, b: 0, c: 0, d: s, e: 0, f: 0 };
      } else if (flags & 0x0040) {
        const sx = data.readInt16BE(offset) / 16384;
        const sy = data.readInt16BE(offset + 2) / 16384;
        offset += 4;
        local = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
      } else if (flags & 0x0080) {
        const a = data.readInt16BE(offset) / 16384;
        const b = data.readInt16BE(offset + 2) / 16384;
        const c = data.readInt16BE(offset + 4) / 16384;
        const d = data.readInt16BE(offset + 6) / 16384;
        offset += 8;
        local = { a, b, c, d, e: 0, f: 0 };
      }
      local = { ...local, e: arg1, f: arg2 };
      const child = glyphContours(font, componentGid, compose(m, local), depth + 1);
      if (child !== null) merged = merged.concat(child);
      if (!(flags & 0x0020)) break;
    }
    return merged.length > 0 ? merged : null;
  } catch {
    return null;
  }
}

/** 二次贝塞尔定步长展平（隐含中点控制点——TrueType on/off 点流→多边形）。 */
function contoursToPolygons(contours: ContourPoint[][], steps = 8): [number, number][][] {
  const polygons: [number, number][][] = [];
  for (const pts of contours) {
    if (pts.length < 3) continue;
    // 首个 on-curve 锚（首尾均 off=中点合成锚）
    let anchorIndex = pts.findIndex((p) => p.on);
    let start: [number, number];
    if (anchorIndex === -1) {
      const first = pts[0]!;
      const last = pts[pts.length - 1]!;
      start = [(first.x + last.x) / 2, (first.y + last.y) / 2];
      anchorIndex = 0;
    } else if (anchorIndex !== 0) {
      start = [pts[anchorIndex]!.x, pts[anchorIndex]!.y];
    } else {
      start = [pts[0]!.x, pts[0]!.y];
    }
    const ring: [number, number][] = [start];
    let cur = start;
    const control: [number, number][] = [];
    const flushTo = (target: [number, number]) => {
      if (control.length === 0) {
        ring.push(target);
      } else {
        let from = cur;
        for (let i = 0; i < control.length; i++) {
          const ctrl = control[i]!;
          const next = i + 1 < control.length
            ? [(ctrl[0] + control[i + 1]![0]) / 2, (ctrl[1] + control[i + 1]![1]) / 2] as [number, number]
            : target;
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const mt = 1 - t;
            ring.push([
              mt * mt * from[0] + 2 * mt * t * ctrl[0] + t * t * next[0],
              mt * mt * from[1] + 2 * mt * t * ctrl[1] + t * t * next[1],
            ]);
          }
          from = next;
        }
      }
      control.length = 0;
      cur = target;
    };
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p = pts[(anchorIndex + i) % n]!;
      if (p.on) {
        flushTo([p.x, p.y]);
      } else {
        control.push([p.x, p.y]);
      }
    }
    flushTo(start); // 闭合
    if (ring.length >= 3) polygons.push(ring);
  }
  return polygons;
}

// ---------------------------------------------------------------- 栅格化（公共面）

export interface CjkGlyphBitmap {
  /** 位图宽高（px）。 */
  width: number;
  height: number;
  /** 步进宽（px——hmtx advance；CJK 全宽≈字号）。 */
  advancePx: number;
  /** width×height coverage（0..1，3×3 超采样 even-odd）。 */
  coverage: Float32Array;
}

const bitmapCache = new Map<string, CjkGlyphBitmap>();

/** 系统字体可用性（诊断/测试面——true=至少一款 glyf 字体解析成功）。 */
export function cjkFontAvailable(): boolean {
  return loadFont() !== null;
}

/**
 * 单字符栅格化（非 ASCII 假定；sizePx=目标字号）。null=无可用字体/未收录/轮廓
 * 不可解析——调用方降级空心方框（bitmap-font drawFallbackBox），绝不抛出。
 */
export function rasterizeCjkGlyph(char: string, sizePx: number): CjkGlyphBitmap | null {
  const code = char.codePointAt(0);
  if (code === undefined || code < 0x80) return null; // ASCII 走点阵——本模块非其面
  if (!Number.isFinite(sizePx) || sizePx <= 0) return null;
  const key = `${code}@${Math.round(sizePx)}`;
  const hit = bitmapCache.get(key);
  if (hit !== undefined) return hit;
  const bitmap = rasterizeUncached(code, Math.round(sizePx));
  if (bitmap !== null) bitmapCache.set(key, bitmap);
  return bitmap;
}

function rasterizeUncached(code: number, sizePx: number): CjkGlyphBitmap | null {
  const font = loadFont();
  if (font === null) return null;
  const gid = cmapLookup(font, code);
  if (gid === 0) return null;
  const contours = glyphContours(font, gid, IDENTITY, 0);
  if (contours === null) return null;
  const polygons = contoursToPolygons(contours);
  if (polygons.length === 0) return null;
  // bbox（px 空间，y 翻转——位图行向下）
  const scale = sizePx / font.unitsPerEm;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polygons) {
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const width = Math.max(1, Math.ceil((maxX - minX) * scale) + 1);
  const height = Math.max(1, Math.ceil((maxY - minY) * scale) + 1);
  if (width * height > 4096 * 4096) return null; // 防御（异常字形/尺寸）
  const toPx = (x: number, y: number): [number, number] => [(x - minX) * scale, height - (y - minY) * scale];
  const edges: Array<[number, number, number, number]> = [];
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const a = toPx(poly[i]![0], poly[i]![1]);
      const b = toPx(poly[(i + 1) % poly.length]![0], poly[(i + 1) % poly.length]![1]);
      if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
    }
  }
  if (edges.length === 0) return null;
  const coverage = new Float32Array(width * height);
  const SUB = 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hits = 0;
      for (let sy = 0; sy < SUB; sy++) {
        const sampleY = y + (sy + 0.5) / SUB;
        const xs: number[] = [];
        for (const [x1, y1, x2, y2] of edges) {
          if (sampleY >= Math.min(y1, y2) && sampleY < Math.max(y1, y2)) {
            xs.push(x1 + ((sampleY - y1) / (y2 - y1)) * (x2 - x1));
          }
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        for (let sx = 0; sx < SUB; sx++) {
          const sampleX = x + (sx + 0.5) / SUB;
          for (let k = 0; k + 1 < xs.length; k += 2) {
            if (sampleX >= xs[k]! && sampleX < xs[k + 1]!) {
              hits += 1;
              break;
            }
          }
        }
      }
      if (hits > 0) coverage[y * width + x] = hits / (SUB * SUB);
    }
  }
  // 步进宽（hmtx；gid 越界 numberOfHMetrics 取末条——spec 同义）
  let advancePx = sizePx;
  try {
    const metricIndex = Math.min(gid, font.hmtx.numberOfHMetrics - 1);
    if (metricIndex >= 0) {
      const advanceUnits = readAt(font.fd, font.hmtx.offset + metricIndex * 4, 2).readUInt16BE(0);
      advancePx = (advanceUnits / font.unitsPerEm) * sizePx;
    }
  } catch {
    advancePx = sizePx;
  }
  return { width, height, advancePx: Math.max(1, Math.round(advancePx)), coverage };
}

/** 测试/诊断面：释放单例（fd 关闭+缓存清空——测试隔离用）。 */
export function disposeCjkFontForTest(): void {
  if (cachedFont !== undefined && cachedFont !== null) {
    try {
      closeSync(cachedFont.fd);
    } catch {
      // 已关闭（进程测试退出竞态）——忽略
    }
  }
  cachedFont = undefined;
  bitmapCache.clear();
}
