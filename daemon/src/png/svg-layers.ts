/**
 * 任务导出四层 SVG 构造器（导出矩阵 2026-10-02——客户「四层 SVG(原图+黑点+编号+
 * 贴图替换)」形态，主仓 docs/客户工作流分析报告.md §1/§2「层结构缺口（易补）」）。
 *
 * 层结构（自下而上渲染序=文件序；层 id 语义化——CorelDRAW 下游编辑友好，客户下游
 * 就是 CDR）：
 *   <g id="source">  原图层——task 输入图 <image> base64 内嵌（>2MB 降级为注释占位）
 *   <g id="holes">   黑点层——孔矢量（fill #000；孔形与 holes.png 同源：round=circle、
 *                    builtin/custom vectorPath=path、custom 仅贴图=方形包络）
 *   <g id="numbers"> 编号层——孔内 <text>（BOM 行号——numbered.png 同源 holeNumberGlyph
 *                    字号口径；sans-serif，CDR 可直接编辑）
 *   <g id="gems">    贴图替换层——<defs> 每款一个 <image> 贴图（builtin=钻库贴图
 *                    blob→dataUrl，box=alphaBounds 主径/纵横比——texture-render 同式；
 *                    custom image=资产 dataUrl s×s 方盒）+逐钻 <use>；缺贴图款降级
 *                    colorHex circle（render.png 降级同语义）。custom vectorPath=path
 *                    fill=colorHex（几何形无贴图）。
 *
 * 兼容（数据元结构保持）：逐钻元素携 data-color-id（=stoneRef）+ data-bom-row
 * （=BOM 行号）——既有 SVG 的 stoneRef 数据元结构保留并扩展行号面。
 * 体积纪律：源图 base64 >2MB → 注释占位层（重组不带大图；362 颗 8 款贴图+四层
 * 实测 <2MB——聚焦测试断言）。
 */
import { gemRadiusPx, type Gem, type GridSpec, type Palette } from 'rhinestone-studio/engine';
import { decodePng } from './codec.js';
import type { ResolveStoneTexture } from './texture-render.js';
import { BUILTIN_PATHS, type ResolveShapeAsset } from './render.js';
import { holeNumberGlyph, type BomLegendRow } from './numbered-sheet.js';

/** 源图内嵌上限（base64 字符数≈字节×4/3——2MB 语义按 dataUrl 长度判）。 */
const SOURCE_EMBED_LIMIT = 2 * 1024 * 1024;
/** 纵横比护栏（texture-render ASPECT_MIN/MAX 同值——异常贴图不放大畸变）。 */
const ASPECT_MIN = 0.1;
const ASPECT_MAX = 10;

export interface LayeredSvgInput {
  gems: Gem[];
  palette: Palette;
  grid: GridSpec;
  width: number;
  height: number;
  /** BOM 行序（编号层数据元——task-export taskBomRowGroupsOf 单源）。 */
  rows: BomLegendRow[];
  /** builtin 形钻库贴图解析（null=缺贴图——gems 层 colorHex circle 降级）。 */
  resolveStoneTexture: ResolveStoneTexture;
  /** custom 形 .gemshape 资产解析。 */
  resolveAsset?: ResolveShapeAsset;
  /** task 输入图（原图层——dataUrl 现成；null=会话图集不可达→注释占位层）。 */
  sourceImage: { mime: string; dataUrl: string } | null;
}

export interface LayeredSvgResult {
  svg: string;
  sourceLayer: 'embedded' | 'oversize-placeholder' | 'missing-placeholder';
  byteLength: number;
}

function n(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** 单位框 path 的逐钻 transform（engine export.ts renderGem 同式——translate+rotate+scale）。 */
function unitPathTransform(gem: Gem, s: number): string {
  const tx = gem.x + 0.5 - s / 2;
  const ty = gem.y + 0.5 - s / 2;
  const rotate = gem.rotationDeg !== undefined ? ` rotate(${n(gem.rotationDeg)} ${n(s / 2)} ${n(s / 2)})` : '';
  return `translate(${n(tx)} ${n(ty)})${rotate} scale(${n(s)} ${n(s)})`;
}

/** 贴图内容盒（主径=s×s——alphaBounds 纵横比保持；texture-render 同式）。 */
function textureBoxOf(
  decoded: { width: number; height: number },
  alphaBounds: { x: number; y: number; w: number; h: number } | undefined,
  s: number,
): { boxW: number; boxH: number } {
  const bounds = alphaBounds ?? { x: 0, y: 0, w: decoded.width, h: decoded.height };
  const aspect = bounds.w / bounds.h;
  const safeAspect = Number.isFinite(aspect) && aspect > ASPECT_MIN && aspect < ASPECT_MAX ? aspect : 1;
  return {
    boxW: safeAspect >= 1 ? s : s * safeAspect,
    boxH: safeAspect >= 1 ? s / safeAspect : s,
  };
}

export function buildLayeredSvg(input: LayeredSvgInput): LayeredSvgResult {
  const { gems, grid, width: W, height: H, rows } = input;
  const ppm = grid.pixelsPerMm;
  const rowByGemKey = new Map<string, number>();
  for (const row of rows) rowByGemKey.set(`${row.stoneRef}\u0000${row.diameterMm}`, row.row);
  const bomRowOf = (gem: Gem): string => {
    const rowNumber = rowByGemKey.get(`${gem.colorId}\u0000${gem.diameterMm}`);
    return rowNumber !== undefined ? String(rowNumber) : '';
  };

  // —— defs：每款贴图一个 <image>（首遇序 tex-1..tex-N；缺贴图款无 defs——逐钻降级 circle）。
  interface TextureDef {
    id: string;
    href: string;
    boxW: number;
    boxH: number;
  }
  const defs: TextureDef[] = [];
  const defIdByKey = new Map<string, string>();
  const dataUrlOfPngBytes = (bytes: Uint8Array): string => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  for (const gem of gems) {
    const s = gem.diameterMm * ppm;
    const key =
      gem.shapeId === 'custom' ? `asset:${gem.assetId ?? '?'}:${gem.diameterMm}` : `stone:${gem.colorId}:${gem.diameterMm}`;
    if (defIdByKey.has(key)) continue;
    if (gem.shapeId === 'custom') {
      const asset = gem.assetId !== undefined ? input.resolveAsset?.(gem.assetId) : undefined;
      if (asset === undefined || asset === null || asset.image === undefined) continue; // vectorPath/缺资产→非贴图路径
      if (asset.image.mime !== 'image/png') continue; // 非 PNG 无解码器（与 texture-render 口径一致——导出门应拦）
      defIdByKey.set(key, `tex-${defs.length + 1}`);
      defs.push({
        id: defIdByKey.get(key)!,
        href: asset.image.dataUrl,
        boxW: s, // custom 资产贴图=全画布→s×s 方盒（texture-render 现状口径）
        boxH: s,
      });
      continue;
    }
    const source = input.resolveStoneTexture(gem.colorId);
    if (source === null) continue; // 缺贴图款——gems 层逐钻 colorHex circle 降级
    let decoded: { width: number; height: number } | null = null;
    try {
      decoded = decodePng(source.bytes);
    } catch {
      decoded = null; // 解码失败——同缺贴图降级
    }
    if (decoded === null) continue;
    defIdByKey.set(key, `tex-${defs.length + 1}`);
    const { boxW, boxH } = textureBoxOf(decoded, source.alphaBounds, s);
    defs.push({ id: defIdByKey.get(key)!, href: dataUrlOfPngBytes(source.bytes), boxW, boxH });
  }

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
  );
  lines.push(
    '<!-- 贴钻导出·四层结构（层序=渲染序，CorelDRAW/ILLUSTRATOR 下游按 id 开关层）：',
    '     #source  原图层（任务输入图——对位参考）',
    '     #holes   黑点层（挖孔模板——刻膜/定位；孔形按钻形，孔径=钻径 1:1）',
    '     #numbers 编号层（孔内编号=BOM 行号——与 bom.csv/numbered.png 对账）',
    '     #gems    贴图替换层（每款钻贴图按位替换——成品效果核对）',
    '     逐钻元素 data-color-id=stoneRef、data-bom-row=BOM 行号 -->',
  );

  /** embedSource=false=体积护栏降级（超限/总重超限——注释占位但保留体积事实）。 */
  const assemble = (embedSource: boolean): LayeredSvgResult => {
    const out: string[] = [...lines];
    const oversize =
      input.sourceImage !== null && (!embedSource || input.sourceImage.dataUrl.length > SOURCE_EMBED_LIMIT);
    // —— #source 原图层
    if (input.sourceImage !== null && !oversize) {
      out.push('<g id="source">');
      out.push(
        `<image href="${input.sourceImage.dataUrl}" xlink:href="${input.sourceImage.dataUrl}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>`,
      );
      out.push('</g>');
    } else if (oversize) {
      out.push(
        `<!-- #source 原图层降级占位：输入图 base64 体积 ${Math.round(input.sourceImage!.dataUrl.length / 1024)}KB 超过 ${Math.round(SOURCE_EMBED_LIMIT / 1024)}KB 上限，未内嵌（对位参考 render.png 与任务原图附件） -->`,
      );
    } else {
      out.push('<!-- #source 原图层降级占位：会话主图集不可达（无输入图引用——对位参考 render.png） -->');
    }
    const sourceLayer: LayeredSvgResult['sourceLayer'] =
      input.sourceImage === null ? 'missing-placeholder' : oversize ? 'oversize-placeholder' : 'embedded';

    // —— #holes 黑点层
    out.push('<g id="holes" fill="#000000">');
    for (const gem of gems) {
      const meta = ` data-color-id="${gem.colorId}"${bomRowOf(gem) !== '' ? ` data-bom-row="${bomRowOf(gem)}"` : ''}`;
      if (gem.shapeId === 'round') {
        const r = gemRadiusPx(gem, grid);
        out.push(`<circle cx="${n(gem.x + 0.5)}" cy="${n(gem.y + 0.5)}" r="${n(r)}"${meta}/>`);
        continue;
      }
      const s = gem.diameterMm * ppm;
      if (gem.shapeId === 'custom') {
        const asset = gem.assetId !== undefined ? input.resolveAsset?.(gem.assetId) : undefined;
        const vectorPath = asset?.vectorPath;
        const d = vectorPath ?? 'M 0 0 H 1 V 1 H 0 Z'; // 仅贴图资产=方形包络（holes.png 同口径）
        const rotate = gem.rotationDeg !== undefined ? ` rotate(${n(gem.rotationDeg)} ${n(s / 2)} ${n(s / 2)})` : '';
        out.push(
          `<path d="${d}" transform="translate(${n(gem.x + 0.5 - s / 2)} ${n(gem.y + 0.5 - s / 2)})${rotate} scale(${n(s)} ${n(s)})"${meta}/>`,
        );
        continue;
      }
      const d = BUILTIN_PATHS[gem.shapeId]!;
      out.push(`<path d="${d}" transform="${unitPathTransform(gem, s)}"${meta}/>`);
    }
    out.push('</g>');

    // —— #numbers 编号层
    out.push('<g id="numbers" fill="#000000" font-family="sans-serif" text-anchor="middle">');
    for (const gem of gems) {
      const rowNumber = rowByGemKey.get(`${gem.colorId}\u0000${gem.diameterMm}`);
      if (rowNumber === undefined) continue;
      const fontPx = holeNumberGlyph(rowNumber, gem.diameterMm, ppm).fontPx;
      out.push(
        `<text x="${n(gem.x + 0.5)}" y="${n(gem.y + 0.5 + fontPx * 0.35)}" font-size="${n(fontPx)}" data-color-id="${gem.colorId}" data-bom-row="${rowNumber}">${rowNumber}</text>`,
      );
    }
    out.push('</g>');

    // —— #gems 贴图替换层（defs+use；缺贴图/几何形降级）
    out.push('<g id="gems">');
    if (defs.length > 0) {
      out.push('<defs>');
      for (const def of defs) {
        out.push(
          `<image id="${def.id}" href="${def.href}" xlink:href="${def.href}" x="0" y="0" width="${n(def.boxW)}" height="${n(def.boxH)}"/>`,
        );
      }
      out.push('</defs>');
    }
    const hexByRef = new Map<string, string>();
    for (const gem of gems) {
      if (!hexByRef.has(gem.colorId)) {
        hexByRef.set(gem.colorId, input.palette.find((entry) => entry.id === gem.colorId)?.hex ?? '#9CA3AF');
      }
    }
    for (const gem of gems) {
      const meta = ` data-color-id="${gem.colorId}"`;
      const key =
        gem.shapeId === 'custom' ? `asset:${gem.assetId ?? '?'}:${gem.diameterMm}` : `stone:${gem.colorId}:${gem.diameterMm}`;
      const defId = defIdByKey.get(key);
      if (defId !== undefined) {
        const def = defs.find((entry) => entry.id === defId)!;
        const cx = gem.x + 0.5;
        const cy = gem.y + 0.5;
        const transform = `translate(${n(cx - def.boxW / 2)} ${n(cy - def.boxH / 2)})${
          gem.rotationDeg !== undefined ? ` rotate(${n(gem.rotationDeg)} ${n(cx)} ${n(cy)})` : ''
        }`;
        out.push(`<use href="#${defId}" xlink:href="#${defId}" transform="${transform}"${meta}/>`);
        continue;
      }
      const hex = hexByRef.get(gem.colorId)!;
      if (gem.shapeId === 'custom') {
        const asset = gem.assetId !== undefined ? input.resolveAsset?.(gem.assetId) : undefined;
        if (asset?.vectorPath !== undefined) {
          const s = gem.diameterMm * ppm;
          out.push(`<path d="${asset.vectorPath}" fill="${hex}" transform="${unitPathTransform(gem, s)}"${meta}/>`);
          continue;
        }
      }
      // 缺贴图款降级：colorHex 色点（render.png 降级同语义）
      const r = gemRadiusPx(gem, grid);
      out.push(`<circle cx="${n(gem.x + 0.5)}" cy="${n(gem.y + 0.5)}" r="${n(r)}" fill="${hex}"${meta}/>`);
    }
    out.push('</g>');
    out.push('</svg>');
    const svg = out.join('\n');
    return { svg, sourceLayer, byteLength: Buffer.byteLength(svg, 'utf8') };
  };

  // 体积护栏：内嵌源图后总重超 2MB → 源图层降级重建（贴图/矢量层 362 颗 8 款实测 <2MB）。
  const embedded = assemble(true);
  if (embedded.sourceLayer === 'embedded' && embedded.byteLength > SOURCE_EMBED_LIMIT) {
    return assemble(false);
  }
  return embedded;
}
