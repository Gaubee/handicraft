/**
 * 贴图六条 gate 单测（add-stone-library design §1.4——S1.3）。
 * 纪律：逐条 gate 至少一红一绿（gem-catalog .gemshape 六条 gate 先例同法）；
 * fixture 全部走本仓纯 TS 编解码器 encodePng 手工组装（零外部依赖、零原生构建）。
 * gate 6（missing 显式态）在 service 层（stones-service.test.ts：缺字节 typed 拒
 * + 引用解析 blob-missing 态）。
 */
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/png/codec.js';
import {
  gateStoneTexture,
  StoneTextureGateError,
  STONE_TEXTURE_LIMITS,
} from '../src/stones/gates.js';

/** 画布内圆形主体（alpha=255 主体+0 背景——bounds 可精确推导）。 */
function circlePng(size: number, diameter: number, rgb: readonly [number, number, number] = [240, 240, 232]): Buffer {
  const rgba = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const r = diameter / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      if (dx * dx + dy * dy <= r * r) {
        const p = (y * size + x) * 4;
        rgba[p] = rgb[0];
        rgba[p + 1] = rgb[1];
        rgba[p + 2] = rgb[2];
        rgba[p + 3] = 255;
      }
    }
  }
  return encodePng(size, size, rgba);
}

/** 横带主体（bounds=全画布——纵横比=宽/高，aspect gate 用）。 */
function bandPng(width: number, height: number): Buffer {
  const rgba = new Uint8Array(width * height * 4).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      rgba[p] = 200;
      rgba[p + 1] = 16;
      rgba[p + 2] = 46;
      rgba[p + 3] = 255;
    }
  }
  return encodePng(width, height, rgba);
}

function expectGateError(input: Parameters<typeof gateStoneTexture>[0], code: string): StoneTextureGateError {
  try {
    gateStoneTexture(input);
  } catch (error) {
    expect(error).toBeInstanceOf(StoneTextureGateError);
    const typed = error as StoneTextureGateError;
    expect(typed.code).toBe(code);
    return typed;
  }
  throw new Error(`期望 gate 拒收（code=${code}）但通过了`);
}

/** 基准绿件：128×128 画布 96px 圆（bounds {16,16,96,96}，ratio 1.0）。 */
const GREEN = circlePng(128, 96);

describe('gate 1 解码实测宽高对账', () => {
  it('红：声明 127×128 ≠ 实测 128×128 → dimension-mismatch（detail 带双侧值）', () => {
    const error = expectGateError(
      { bytes: GREEN, declaredWidth: 127, declaredHeight: 128, sizeMm: 2 },
      'dimension-mismatch',
    );
    expect(error.detail).toMatchObject({ declaredWidth: 127, width: 128 });
  });
  it('绿：声明正确 → 通过，实测值以解码为准回传', () => {
    const result = gateStoneTexture({ bytes: GREEN, declaredWidth: 128, declaredHeight: 128, sizeMm: 2 });
    expect(result.width).toBe(128);
    expect(result.height).toBe(128);
  });
});

describe('gate 2 输入上限', () => {
  it('红：输入字节 > 2MB → input-bytes-over-limit（字节检查先于解码——炸弹不进解码器）', () => {
    expectGateError(
      {
        bytes: new Uint8Array(STONE_TEXTURE_LIMITS.maxInputBytes + 1),
        declaredWidth: 128,
        declaredHeight: 128,
      },
      'input-bytes-over-limit',
    );
  });
  it('绿：2MB 边界值本身放行字节门（≤ 上限；零填充非 PNG→落 not-png，证明字节门判据是「>」）', () => {
    const padded = Buffer.alloc(STONE_TEXTURE_LIMITS.maxInputBytes, 0);
    expect(padded.byteLength).toBe(STONE_TEXTURE_LIMITS.maxInputBytes);
    expectGateError({ bytes: padded, declaredWidth: 128, declaredHeight: 128 }, 'not-png');
  });
  it('红：边长 4097 > 4096 → edge-over-limit', () => {
    const wide = bandPng(4097, 2);
    expectGateError({ bytes: wide, declaredWidth: 4097, declaredHeight: 2 }, 'edge-over-limit');
  });
  it('绿：边长恰 4096 放行（marquise 自由归类免比例门——边长绿件专用）', () => {
    const wide = bandPng(4096, 64);
    const result = gateStoneTexture({
      bytes: wide,
      declaredWidth: 4096,
      declaredHeight: 64,
      shapeClass: 'marquise',
      sizeMm: 25,
    });
    expect(result.width).toBe(4096);
  });
  it('红：像素总量上限独立生效（limits 可参覆写——防炸弹贴图第二防线）', () => {
    expectGateError(
      {
        bytes: GREEN,
        declaredWidth: 128,
        declaredHeight: 128,
        limits: { maxPixels: 100 },
      },
      'pixels-over-limit',
    );
  });
});

describe('gate 3 alpha 内容 bounds 非空', () => {
  it('红：全透明 → fully-transparent（bounds 为空）', () => {
    const blank = encodePng(128, 128, new Uint8Array(128 * 128 * 4));
    expectGateError({ bytes: blank, declaredWidth: 128, declaredHeight: 128 }, 'fully-transparent');
  });
  it('绿：有主体 → bounds 取 alpha>0 最小包围盒（非画布外框）', () => {
    const result = gateStoneTexture({ bytes: GREEN, declaredWidth: 128, declaredHeight: 128, sizeMm: 2 });
    expect(result.alphaBounds).toEqual({ x: 16, y: 16, w: 96, h: 96 });
  });
});

describe('gate 4 fit 比例与几何归类一致', () => {
  it('红：round 声明 + 4:1 横带主体 → aspect-drift（比例漂移即物理尺寸谎言）', () => {
    const wide = bandPng(256, 64);
    const error = expectGateError(
      { bytes: wide, declaredWidth: 256, declaredHeight: 64, shapeClass: 'round', sizeMm: 2 },
      'aspect-drift',
    );
    expect(error.detail).toMatchObject({ shapeClass: 'round' });
  });
  it('绿：round + 1:1 主体 → 通过；容差内（1.2 ≤ 1.25）也通过', () => {
    expect(() =>
      gateStoneTexture({ bytes: GREEN, declaredWidth: 128, declaredHeight: 128, shapeClass: 'round', sizeMm: 2 }),
    ).not.toThrow();
    // 80×96 主体（ratio 1.2，容差内）
    const nearSquare = bandPng(80, 96);
    expect(() =>
      gateStoneTexture({ bytes: nearSquare, declaredWidth: 80, declaredHeight: 96, shapeClass: 'round', sizeMm: 2 }),
    ).not.toThrow();
  });
  it('绿：非 1:1 自由归类（marquise）宽主体不拒——期望比未知不预设', () => {
    const wide = bandPng(256, 64);
    expect(() =>
      gateStoneTexture({ bytes: wide, declaredWidth: 256, declaredHeight: 64, shapeClass: 'marquise', sizeMm: 2 }),
    ).not.toThrow();
  });
});

describe('gate 5 分辨率下限', () => {
  it('红：主径 40px < 64px 绝对下限 → resolution-too-low', () => {
    const tiny = circlePng(64, 40);
    expectGateError({ bytes: tiny, declaredWidth: 64, declaredHeight: 64 }, 'resolution-too-low');
  });
  it('绿：主径恰 64px（边界含）→ 通过；建议 px/mm 达标与否为 advisory 不阻断', () => {
    const edge = circlePng(96, 64);
    const result = gateStoneTexture({ bytes: edge, declaredWidth: 96, declaredHeight: 96, sizeMm: 1 });
    expect(result.subjectMajorPx).toBe(64);
    // 64px/1mm=64 ≥ 32 → 达标；同主体对 25mm（64/25=2.56 < 32）→ 不达标但放行
    expect(result.meetsRecommendedPxPerMm).toBe(true);
    const coarse = gateStoneTexture({ bytes: edge, declaredWidth: 96, declaredHeight: 96, sizeMm: 25 });
    expect(coarse.meetsRecommendedPxPerMm).toBe(false);
    const noSize = gateStoneTexture({ bytes: edge, declaredWidth: 96, declaredHeight: 96, sizeMm: null });
    expect(noSize.meetsRecommendedPxPerMm).toBe(null);
  });
});

describe('非 PNG/解码失败（gate 2 前置面）', () => {
  it('红：JPEG 魔数 → not-png（仅收 PNG）', () => {
    expectGateError(
      { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]), declaredWidth: 1, declaredHeight: 1 },
      'not-png',
    );
  });
  it('红：合法 PNG 截断 → decode-failed', () => {
    const truncated = GREEN.subarray(0, Math.floor(GREEN.byteLength / 2));
    expectGateError({ bytes: truncated, declaredWidth: 128, declaredHeight: 128 }, 'decode-failed');
  });
  it('绿：完整 PNG → 通过（基准绿件复跑）', () => {
    expect(() => gateStoneTexture({ bytes: GREEN, declaredWidth: 128, declaredHeight: 128 })).not.toThrow();
  });
});
