/**
 * 入线重采样单测（realize-scene-understanding W1 + 2026-10-04 工作画布确定性裁定）。
 * 覆盖：配置面（缺省/开关/clamp）/规划面（规范网格恒等推导·降采/升采/边界相等·
 * 主轴密度·纵横比漂移透传·缺物理尺寸兜底 2048·关闭透传）/执行面（面积加权均值
 * 精确值·分数覆盖·恒等·升采常数守恒·确定性·alpha 保 255·PNG 往返）/编排面
 * （applyIntakeResample 双路同锚——Bug A 回归）。纯函数零 IO——确定性断言。
 */
import { describe, expect, it } from 'vitest';
import {
  PPCM_FALLBACK_MAX_EDGE_PX,
  PPCM_TARGET_DEFAULT,
  PPCM_TARGET_MAX,
  PPCM_TARGET_MIN,
  planIntakeResample,
  resolveIntakeResampleConfig,
  resampleRgbaArea,
  type IntakeResampleConfig,
} from '../src/kernel/vision/intake-resample.js';

const CFG = (over: Partial<IntakeResampleConfig> = {}): IntakeResampleConfig => ({
  enabled: true,
  ppcmTarget: PPCM_TARGET_DEFAULT,
  ...over,
});

// ---------------------------------------------------------------- 配置面

describe('resolveIntakeResampleConfig', () => {
  it('缺省：开+25px/cm', () => {
    expect(resolveIntakeResampleConfig({})).toEqual({ enabled: true, ppcmTarget: 25 });
  });

  it('PPCM_RESAMPLE=0 关（透传旧行为）；其他值/缺席=开', () => {
    expect(resolveIntakeResampleConfig({ PPCM_RESAMPLE: '0' }).enabled).toBe(false);
    expect(resolveIntakeResampleConfig({ PPCM_RESAMPLE: '1' }).enabled).toBe(true);
    expect(resolveIntakeResampleConfig({ PPCM_RESAMPLE: ' 0 ' }).enabled).toBe(false);
  });

  it('PPCM_TARGET 合法值直取；越界 clamp 10..50；坏值落缺省 25', () => {
    expect(resolveIntakeResampleConfig({ PPCM_TARGET: '40' }).ppcmTarget).toBe(40);
    expect(resolveIntakeResampleConfig({ PPCM_TARGET: '5' }).ppcmTarget).toBe(PPCM_TARGET_MIN);
    expect(resolveIntakeResampleConfig({ PPCM_TARGET: '100' }).ppcmTarget).toBe(PPCM_TARGET_MAX);
    expect(resolveIntakeResampleConfig({ PPCM_TARGET: 'abc' }).ppcmTarget).toBe(PPCM_TARGET_DEFAULT);
    expect(resolveIntakeResampleConfig({ PPCM_TARGET: '' }).ppcmTarget).toBe(PPCM_TARGET_DEFAULT);
  });
});

// ---------------------------------------------------------------- 规划面

describe('planIntakeResample', () => {
  it('密度超目标 → 等比降采到目标（50px/cm→25：尺寸减半）', () => {
    const plan = planIntakeResample({ width: 1000, height: 1000, canvasCm: { w: 20, h: 20 } }, CFG());
    expect(plan.resampled).toBe(true);
    expect(plan.reason).toBe('density-cap');
    expect(plan.width).toBe(500);
    expect(plan.height).toBe(500);
    expect(plan.scale).toBeCloseTo(0.5);
    expect(plan.ppcmBefore).toBeCloseTo(50);
    expect(plan.ppcmAfter).toBeCloseTo(25);
  });

  it('升采到规范网格（2026-10-04 恒等推导）：密度低于目标同样推导到 canvasCm×ppcm', () => {
    const low = planIntakeResample({ width: 400, height: 400, canvasCm: { w: 20, h: 20 } }, CFG());
    expect(low.resampled).toBe(true);
    expect(low.reason).toBe('density-lift');
    expect(low.width).toBe(500);
    expect(low.height).toBe(500);
    expect(low.scale).toBeCloseTo(1.25);
    expect(low.ppcmBefore).toBeCloseTo(20);
    expect(low.ppcmAfter).toBeCloseTo(25);
    // 边界相等=规范网格已就位 → 直通（幂等：intake 图再推导零变迁）
    const equal = planIntakeResample(
      { width: 500, height: 500, canvasCm: { w: 20, h: 20 } },
      CFG({ ppcmTarget: 25 }),
    );
    expect(equal.resampled).toBe(false);
  });

  it('Bug A 回归·双路同锚：任意上传尺寸（JPEG 转码路 3000 / PNG 直传路 1280 / 小图 400）→ 同一规范网格 500', () => {
    const canvasCm = { w: 20, h: 20 };
    for (const source of [3000, 1280, 736, 400]) {
      const plan = planIntakeResample({ width: source, height: source, canvasCm }, CFG());
      expect(plan.resampled).toBe(true);
      expect(plan.width).toBe(500);
      expect(plan.height).toBe(500);
    }
  });

  it('设置跟随：改 ppcmTarget 新任务推导即刻换网格（40px/cm → 20cm=800px；10 下限 → 200px）', () => {
    const quality = planIntakeResample(
      { width: 1280, height: 1280, canvasCm: { w: 20, h: 20 } },
      CFG({ ppcmTarget: 40 }),
    );
    expect(quality.resampled).toBe(true);
    expect(quality.width).toBe(800);
    expect(quality.height).toBe(800);
    const fast = planIntakeResample(
      { width: 1280, height: 1280, canvasCm: { w: 20, h: 20 } },
      CFG({ ppcmTarget: PPCM_TARGET_MIN }),
    );
    expect(fast.width).toBe(200);
    expect(fast.height).toBe(200);
  });

  it('纵横比漂移超 2% → 透传不拉伸（S1 derivePixelsPerMm 显式拒的迟到面保留）', () => {
    // 3:4 图声明 1:1 画布（漂移 25%>2%）——不静默畸变成 500×500
    const plan = planIntakeResample({ width: 1500, height: 2000, canvasCm: { w: 20, h: 20 } }, CFG());
    expect(plan.resampled).toBe(false);
    expect(plan.width).toBe(1500);
    expect(plan.height).toBe(2000);
  });

  it('主轴密度：非方形画布按更密轴判定（纵横比一致两轴等价）', () => {
    // 2000×1000 @ 40×20cm=50px/cm（两轴同密度）→ 目标 25 → 1000×500
    const plan = planIntakeResample(
      { width: 2000, height: 1000, canvasCm: { w: 40, h: 20 } },
      CFG(),
    );
    expect(plan.resampled).toBe(true);
    expect(plan.width).toBe(1000);
    expect(plan.height).toBe(500);
  });

  it('现行 736px/20cm（36.8px/cm>25）会触发——A/B 裁定接受统一目标（见任务报告）', () => {
    const plan = planIntakeResample({ width: 736, height: 736, canvasCm: { w: 20, h: 20 } }, CFG());
    expect(plan.resampled).toBe(true);
    expect(plan.width).toBe(500);
    expect(plan.height).toBe(500);
  });

  it('物理尺寸缺失：长边 2048 兜底封顶（超才降；不超直通）', () => {
    const over = planIntakeResample({ width: 4096, height: 2048, canvasCm: null }, CFG());
    expect(over.resampled).toBe(true);
    expect(over.reason).toBe('edge-fallback');
    expect(over.width).toBe(PPCM_FALLBACK_MAX_EDGE_PX);
    expect(over.height).toBe(1024);
    const within = planIntakeResample({ width: 2048, height: 1024, canvasCm: null }, CFG());
    expect(within.resampled).toBe(false);
  });

  it('关闭（PPCM_RESAMPLE=0 语义）→ 一律透传 reason=none', () => {
    const plan = planIntakeResample(
      { width: 4000, height: 4000, canvasCm: { w: 20, h: 20 } },
      CFG({ enabled: false }),
    );
    expect(plan.resampled).toBe(false);
    expect(plan.reason).toBe('none');
    expect(plan.width).toBe(4000);
  });

  it('目标密度 clamp 后语义一致（10 下限：20cm 图长边至多 200px）', () => {
    const plan = planIntakeResample(
      { width: 2000, height: 1000, canvasCm: { w: 20, h: 10 } },
      CFG({ ppcmTarget: PPCM_TARGET_MIN }),
    );
    expect(plan.resampled).toBe(true);
    expect(plan.width).toBe(200);
    expect(plan.height).toBe(100);
  });
});

// ---------------------------------------------------------------- 执行面

describe('resampleRgbaArea', () => {
  it('恒等尺寸：原平面直通（零拷贝语义——同引用）', () => {
    const rgba = new Uint8Array(16);
    expect(resampleRgbaArea(rgba, 2, 2, 2, 2)).toBe(rgba);
  });

  it('整数倍降采=块均值精确值（2×2 常数块→1×1）', () => {
    // 2×2 图：R 通道 4 像素 10/20/30/40 → 均值 25；G=100 常数；B=0；A=255
    const rgba = new Uint8Array(16);
    const pixels = [
      [10, 100, 0],
      [20, 100, 0],
      [30, 100, 0],
      [40, 100, 0],
    ];
    pixels.forEach((p, i) => {
      rgba[i * 4] = p[0]!;
      rgba[i * 4 + 1] = p[1]!;
      rgba[i * 4 + 2] = p[2]!;
      rgba[i * 4 + 3] = 255;
    });
    const out = resampleRgbaArea(rgba, 2, 2, 1, 1);
    expect([...out]).toEqual([25, 100, 0, 255]);
  });

  it('分数覆盖=面积加权（3→2：中间像素跨两个目标窗）', () => {
    // 3×1 → 2×1：sx=1.5。窗口 [0,1.5) 覆盖 px0 全份+px1 半份；[1.5,3) 覆盖 px1 半份+px2 全份。
    const rgba = new Uint8Array(12);
    const r = [0, 60, 120];
    for (let i = 0; i < 3; i++) {
      rgba[i * 4] = r[i]!;
      rgba[i * 4 + 1] = 0;
      rgba[i * 4 + 2] = 0;
      rgba[i * 4 + 3] = 255;
    }
    const out = resampleRgbaArea(rgba, 3, 1, 2, 1);
    expect(out[0]).toBe(Math.round((0 * 1 + 60 * 0.5) / 1.5)); // 20
    expect(out[4]).toBe(Math.round((60 * 0.5 + 120 * 1) / 1.5)); // 100
    expect(out[0]).toBe(20);
    expect(out[4]).toBe(100);
  });

  it('空图拒（规划面构造排除——执行面守卫 typed）；升采成立（box 上采样常数守恒+确定性）', () => {
    const rgba = new Uint8Array(16);
    expect(() => resampleRgbaArea(rgba, 2, 2, 0, 1)).toThrow(/目标尺寸非法/);
    // 升采 2×2 → 4×4：常数图守恒（无漂移）；同入参两次产物逐字节一致（确定性）。
    const src = new Uint8Array(16);
    for (let i = 0; i < 4; i++) {
      src[i * 4] = 90;
      src[i * 4 + 1] = 120;
      src[i * 4 + 2] = 200;
      src[i * 4 + 3] = 255;
    }
    const up = resampleRgbaArea(src, 2, 2, 4, 4);
    expect(up.length).toBe(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      expect([up[i * 4], up[i * 4 + 1], up[i * 4 + 2], up[i * 4 + 3]]).toEqual([90, 120, 200, 255]);
    }
    expect([...resampleRgbaArea(src, 2, 2, 4, 4)]).toEqual([...up]);
  });

  it('确定性+守恒：常数图降采后仍是同常数（无漂移）', () => {
    const W = 37;
    const H = 23;
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = 77;
      rgba[i * 4 + 1] = 151;
      rgba[i * 4 + 2] = 203;
      rgba[i * 4 + 3] = 255;
    }
    const out = resampleRgbaArea(rgba, W, H, 13, 7);
    for (let i = 0; i < 13 * 7; i++) {
      expect([out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]]).toEqual([77, 151, 203, 255]);
    }
  });

  it('PNG 往返：encode→decode 尺寸/内容一致（锚点图重建面可用）', async () => {
    const { encodePng, decodePng } = await import('../src/png/codec.js');
    const W = 48;
    const H = 32;
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = (i * 7) % 256;
      rgba[i * 4 + 1] = (i * 13) % 256;
      rgba[i * 4 + 2] = (i * 29) % 256;
      rgba[i * 4 + 3] = 255;
    }
    const down = resampleRgbaArea(rgba, W, H, 20, 13);
    const png = encodePng(20, 13, down);
    const decoded = decodePng(png);
    expect(decoded.width).toBe(20);
    expect(decoded.height).toBe(13);
    expect([...decoded.rgba]).toEqual([...down]);
  });
});
