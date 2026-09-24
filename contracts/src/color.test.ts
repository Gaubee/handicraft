/**
 * ΔE CIE76 双端一致测试（add-stone-library tasks S0.2——锁死不漂移）。
 * 对拍基准（人工核对，2026-09-24 以 node type-striping 直接运行
 * rhinestone-studio/src/lib/engine/color.ts 的 labFromRgb/deltaE76 实跑输出抄录）：
 * 向量含 sRGB gamma 拐点（10/11≈0.04045×255）与 fLab 线性段拐点（近黑 tiny/kneeA）。
 * 本包不 import 引擎（独立可发布——paving.test.ts 同纪律）；引擎源以 vite `?raw`
 * 文本导入作漂移绊线（仅测试面；raw-modules.d.ts 提供声明）：engine 常数改动或
 * 本副本漂移任一发生即红。
 */
import { describe, expect, it } from 'vitest';
import engineColorSrc from '../../rhinestone-studio/src/lib/engine/color.ts?raw';
import { deltaE76, labFromRgb } from './color.js';
import mirrorColorSrc from './color.ts?raw';

const lab = {
  black: { L: 0, a: 0, b: 0 },
  white: { L: 100.00000386666655, a: -0.000016666666158293708, b: 0.000006666666463317483 },
  midGray: { L: 53.585015771669404, a: -0.000009997846439624425, b: 0.00000399913857584977 },
  red: { L: 53.240794141307205, a: 80.09245959641115, b: 67.20319651585298 },
  green: { L: 87.73472235279792, a: -86.1827164205346, b: 83.17932050269783 },
  blue: { L: 32.297010932850725, a: 79.18751984512224, b: -107.8601617541481 },
  ivory: { L: 99.63990282276274, a: -2.551393440697103, b: 7.162635096575398 },
  champagne: { L: 92.30213423654254, a: 1.445996274152983, b: 14.133293354713139 },
  bronzeGold: { L: 60.240820958879894, a: 24.016663458460428, b: 52.32981424612385 },
  deepRed: { L: 28.089770555957962, a: 50.999677439595466, b: 41.290760711409966 },
  kneeA: { L: 2.7417595165725714, a: -0.0000011817927747515, b: 4.727171099006e-7 },
  kneeB: { L: 3.022926057822687, a: -0.0000013029852474755188, b: 5.211940989902075e-7 },
  tiny: { L: 0.5098307617282813, a: -0.12244785530925173, b: -0.4705977183223409 },
  darkLabKnee: { L: 13.327702272122039, a: 47.61537841571376, b: -64.09866426258914 },
} as const;

describe('labFromRgb：engine 实跑向量对拍（同值断言）', () => {
  const cases: Array<[name: string, rgb: [number, number, number]]> = [
    ['black', [0, 0, 0]],
    ['white', [255, 255, 255]],
    ['midGray', [128, 128, 128]],
    ['red', [255, 0, 0]],
    ['green', [0, 255, 0]],
    ['blue', [0, 0, 255]],
    ['ivory', [255, 255, 240]],
    ['champagne', [247, 231, 206]],
    ['bronzeGold', [205, 127, 50]],
    ['deepRed', [139, 0, 0]],
    ['kneeA', [10, 10, 10]],
    ['kneeB', [11, 11, 11]],
    ['tiny', [1, 2, 3]],
    ['darkLabKnee', [9, 0, 128]],
  ];
  it.each(cases)('%s 逐分量同值（12 位精度）', (name, [r, g, b]) => {
    const got = labFromRgb(r, g, b);
    const want = lab[name as keyof typeof lab];
    expect(got.L).toBeCloseTo(want.L, 12);
    expect(got.a).toBeCloseTo(want.a, 12);
    expect(got.b).toBeCloseTo(want.b, 12);
  });
});

describe('deltaE76：engine 实跑向量对拍（同值断言）', () => {
  it.each([
    ['black-white', 'black', 'white', 100.00000386666815],
    ['red-green', 'red', 'green', 170.56524200601012],
    ['ivory-champagne', 'ivory', 'champagne', 10.881730051285642],
    ['black-black（自距=0）', 'black', 'black', 0],
    ['red-blue', 'red', 'blue', 176.3140390888004],
    ['kneeA-kneeB', 'kneeA', 'kneeB', 0.2811665412501459],
  ] as const)('%s 同值（12 位精度）', (_label, x, y, expected) => {
    expect(deltaE76(lab[x], lab[y])).toBeCloseTo(expected, 12);
  });
  it('对称性 dE(a,b)=dE(b,a)', () => {
    expect(deltaE76(lab.ivory, lab.bronzeGold)).toBe(deltaE76(lab.bronzeGold, lab.ivory));
  });
});

describe('引擎源常量漂移绊线（engine color.ts ↔ 本包副本双向锁）', () => {
  /** 算法常数清单——engine 与副本必须同时含全部字面量，任一漂移即红。 */
  const CONSTANTS = [
    'D65_X = 0.95047',
    'D65_Y = 1.0',
    'D65_Z = 1.08883',
    '0.04045',
    '12.92',
    '0.055',
    '2.4',
    '216 / 24389',
    '903.3',
    '0.4124564',
    '0.3575761',
    '0.1804375',
    '0.2126729',
    '0.7151522',
    '0.072175',
    '0.0193339',
    '0.119192',
    '0.9503041',
    '116 * fy - 16',
    '500 * (fx - fy)',
    '200 * (fy - fz)',
  ] as const;

  it('engine 与副本含同一套算法常数（任一端改动 → 重新对拍同步）', () => {
    for (const constant of CONSTANTS) {
      expect(engineColorSrc, `engine color.ts 缺少常数 ${constant}（算法已漂移——重新对拍并同步副本）`).toContain(constant);
      expect(mirrorColorSrc, `contracts color.ts 副本缺少常数 ${constant}（与 engine 漂移——禁止单端修改）`).toContain(constant);
    }
  });
});
