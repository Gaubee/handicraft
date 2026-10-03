/**
 * 掩膜质量门单测（add-vision-pipeline-v2 T2.3 / design D5——三几何先验纯函数）。
 * 病态样本取自生产实证（三天使图 round2，2026-10-03 Owner 定调）：
 *   - 右发型泄漏：95×288 全身条带（细长越带且贯穿父高 / 整片父 IoU≈1 两面可命中）；
 *   - 中发型空膜：bbox 内填充率 ≈1%（碎片残留型近空膜）。
 * 覆盖：三先验各自独立命中/合法细长不误伤/阈值注入覆写/健康掩膜零 flags。
 * 纯函数零 IO——合成 bits 直喂。tasks 2.5「构造合成掩膜即可，不真调桥」的纯函数面。
 */
import { describe, expect, it } from 'vitest';
import type { NodeBBox } from '@handicraft/contracts';
import {
  evaluateMaskQuality,
  MASK_QUALITY_DEFAULTS,
  type MaskQualityThresholds,
} from '../src/kernel/vision/mask-quality.js';

const W = 400;
const H = 400;

/** 画布级 bits：rects 并集填充。 */
function bitsOf(...rects: NodeBBox[]): Uint8Array {
  const bits = new Uint8Array(W * H);
  for (const b of rects) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) bits[y * W + x] = 1;
    }
  }
  return bits;
}

function bbox(x: number, y: number, w: number, h: number): NodeBBox {
  return { x, y, w, h };
}

describe('掩膜质量门（D5 三先验——纯函数）', () => {
  it('右发型·整片父泄漏：子掩膜≈父全部 → mask-parent-iou 命中（IoU=1）', () => {
    // 父=人物 100×320；SAM 对「右发」提示返回几乎整个父区域（整身泄漏）
    const parent = bbox(20, 40, 100, 320);
    const child = parent; // 泄漏极值：子=父
    const flags = evaluateMaskQuality({
      bits: bitsOf(child),
      bbox: child,
      imagePx: { width: W, height: H },
      parent: { bbox: parent, bits: bitsOf(parent) },
    });
    const reasons = flags.map((f) => f.reason);
    expect(reasons).toContain('mask-parent-iou');
    expect(flags.find((f) => f.reason === 'mask-parent-iou')!.detail).toContain('IoU');
  });

  it('右发型·条带泄漏：95×300 条带 ⊂ 100×320 父（IoU 未达上限）→ mask-suspicious-aspect 命中', () => {
    const parent = bbox(20, 40, 100, 320);
    const child = bbox(22, 50, 95, 300); // aspect 95/300≈0.32 ∉ [0.5,2]；h=300 > 0.9×320=288
    const flags = evaluateMaskQuality({
      bits: bitsOf(child),
      bbox: child,
      imagePx: { width: W, height: H },
      parent: { bbox: parent, bits: bitsOf(parent) },
    });
    const reasons = flags.map((f) => f.reason);
    expect(reasons).toContain('mask-suspicious-aspect');
    expect(reasons).not.toContain('mask-parent-iou'); // IoU=28500/32000≈0.89 < 0.95——独立先验不误报
    expect(reasons).not.toContain('mask-suspicious-fill'); // 实心条带填充率 100%
  });

  it('中发型·空膜：bbox 200×200 内仅 1% 置位 → mask-suspicious-fill 命中', () => {
    const sparse = bbox(100, 100, 200, 200);
    const core = bbox(190, 190, 20, 20); // 400/40000 = 1%
    const flags = evaluateMaskQuality({
      bits: bitsOf(core),
      bbox: sparse,
      imagePx: { width: W, height: H },
    });
    const reasons = flags.map((f) => f.reason);
    expect(reasons).toContain('mask-suspicious-fill');
    expect(reasons).not.toContain('mask-suspicious-aspect'); // aspect=1 在带内
  });

  it('健康掩膜（实心矩形，无父）零 flags；合法细长（发丝/缎带未贯穿基准）不误伤', () => {
    // 实心 150×150 顶层节点
    expect(
      evaluateMaskQuality({
        bits: bitsOf(bbox(50, 50, 150, 150)),
        bbox: bbox(50, 50, 150, 150),
        imagePx: { width: W, height: H },
      }),
    ).toEqual([]);
    // 细长发丝 30×300：aspect≈0.1 越 [0.5,2] 带，但 h=300 ≤ 0.9×画布高 400=360
    // ——设计「宽容带**或**高度 ≤父 90%」的合法细长半边，不误伤
    expect(
      evaluateMaskQuality({
        bits: bitsOf(bbox(50, 50, 30, 300)),
        bbox: bbox(50, 50, 30, 300),
        imagePx: { width: W, height: H },
      }),
    ).toEqual([]);
    // 细长且贯穿画布（30×400 > 360）=可疑（顶层级条带泄漏同判——高度基准无父回画布）
    const strip = evaluateMaskQuality({
      bits: bitsOf(bbox(50, 0, 30, 400)),
      bbox: bbox(50, 0, 30, 400),
      imagePx: { width: W, height: H },
    });
    expect(strip.map((f) => f.reason)).toEqual(['mask-suspicious-aspect']);
  });

  it('阈值注入覆写：minFill 放宽后 1% 空膜不再告警；parentIouCeiling 提高=IoU 不告警', () => {
    const sparseInput = {
      bits: bitsOf(bbox(190, 190, 20, 20)),
      bbox: bbox(100, 100, 200, 200),
      imagePx: { width: W, height: H } as { width: number; height: number },
    };
    const loose: MaskQualityThresholds = { ...MASK_QUALITY_DEFAULTS, minFill: 0.001 };
    expect(evaluateMaskQuality(sparseInput, loose)).toEqual([]);
    // 整片父泄漏在 IoU 上限拔高到 1.0（禁用语义）后不告警（aspect 仍独立评估）
    const parent = bbox(20, 40, 100, 320);
    const leak = evaluateMaskQuality(
      {
        bits: bitsOf(parent),
        bbox: parent,
        imagePx: { width: W, height: H },
        parent: { bbox: parent, bits: bitsOf(parent) },
      },
      { ...MASK_QUALITY_DEFAULTS, parentIouCeiling: 1 },
    );
    expect(leak.map((f) => f.reason)).not.toContain('mask-parent-iou');
  });
});
