/**
 * 图像处理设置契约测试（add-image-processing-settings tasks 1.1——冻结契约面
 * schema 把守）。覆盖：
 *   [1] ImageProcessingValuesSchema 四参数边界：ppcm int 10..50（9/51 拒）、
 *       conf 0.05..0.95（0.04/0.96 拒）、maskMaxSide int ≥32（31 拒；null=原尺寸过）。
 *   [2] ImageProcessingSaveInputSchema 联合分支（P2-2 discriminated union）：reset=true
 *       往返+混入未知字段拒（.strict()）/ reset 非 true 拒 / custom 缺 values schema
 *       拒（冻结在 contracts——编译期+schema+运行期一致）/ 三预设分支 values 可带可
 *       不带（服务端按冻结映射生成快照，入参忽略）。
 *   [3] ImageProcessingSettingsSchema 存储面：values 恒在场（custom 缺 values 拒——
 *       快照语义：非 custom 档也存映射快照）；preset 四值枚举外拒。
 *   [4] ImageProcessingGetOutputSchema：settings nullable 两态往返、source 三值、
 *       env 投影（ppcmTarget/resampleDisabled 可选在场）。
 */
import { describe, expect, it } from 'vitest';
import {
  ImageProcessingEnvStateSchema,
  ImageProcessingGetOutputSchema,
  ImageProcessingPresetSchema,
  ImageProcessingSaveInputSchema,
  ImageProcessingSettingsSchema,
  ImageProcessingValuesSchema,
  type ImageProcessingPreset,
  type ImageProcessingValues,
} from './index.js';

/** 最小合法四参数（=冻结映射 quality 档值——非特殊值，任意合法组合均可）。 */
function values(overrides: Partial<ImageProcessingValues> = {}): ImageProcessingValues {
  return {
    ppcmTarget: 25,
    resampleEnabled: true,
    samConfThreshold: 0.4,
    samMaskMaxSide: null,
    ...overrides,
  };
}

describe('ImageProcessingValuesSchema（四参数边界）', () => {
  it('ppcmTarget int 10..50：9/51 拒、10/50 过、非整数拒', () => {
    expect(ImageProcessingValuesSchema.safeParse(values({ ppcmTarget: 9 })).success).toBe(false);
    expect(ImageProcessingValuesSchema.safeParse(values({ ppcmTarget: 51 })).success).toBe(false);
    expect(ImageProcessingValuesSchema.safeParse(values({ ppcmTarget: 10 })).success).toBe(true);
    expect(ImageProcessingValuesSchema.safeParse(values({ ppcmTarget: 50 })).success).toBe(true);
    expect(ImageProcessingValuesSchema.safeParse(values({ ppcmTarget: 25.5 })).success).toBe(false);
  });

  it('samConfThreshold 0.05..0.95：0.04/0.96 拒、两端过', () => {
    expect(ImageProcessingValuesSchema.safeParse(values({ samConfThreshold: 0.04 })).success).toBe(false);
    expect(ImageProcessingValuesSchema.safeParse(values({ samConfThreshold: 0.96 })).success).toBe(false);
    expect(ImageProcessingValuesSchema.safeParse(values({ samConfThreshold: 0.05 })).success).toBe(true);
    expect(ImageProcessingValuesSchema.safeParse(values({ samConfThreshold: 0.95 })).success).toBe(true);
  });

  it('samMaskMaxSide int ≥32：31 拒、32 过、null=原尺寸过、非整数拒', () => {
    expect(ImageProcessingValuesSchema.safeParse(values({ samMaskMaxSide: 31 })).success).toBe(false);
    expect(ImageProcessingValuesSchema.safeParse(values({ samMaskMaxSide: 32 })).success).toBe(true);
    expect(ImageProcessingValuesSchema.safeParse(values({ samMaskMaxSide: 1024 })).success).toBe(true);
    expect(ImageProcessingValuesSchema.safeParse(values({ samMaskMaxSide: null })).success).toBe(true);
    expect(ImageProcessingValuesSchema.safeParse(values({ samMaskMaxSide: 100.5 })).success).toBe(false);
  });

  it('resampleEnabled 非 boolean 拒；四字段缺一拒', () => {
    expect(ImageProcessingValuesSchema.safeParse({ ...values(), resampleEnabled: 'off' }).success).toBe(false);
    const { ppcmTarget: _drop, ...missing } = values();
    expect(ImageProcessingValuesSchema.safeParse(missing).success).toBe(false);
  });
});

describe('ImageProcessingSaveInputSchema（写面联合分支——P2-2 discriminated union）', () => {
  it('reset 分支往返：{reset:true} 过；reset 非 true 拒；混入 preset/values 等未知字段拒（.strict()）', () => {
    expect(ImageProcessingSaveInputSchema.parse({ reset: true })).toEqual({ reset: true });
    expect(ImageProcessingSaveInputSchema.safeParse({ reset: false }).success).toBe(false);
    expect(
      ImageProcessingSaveInputSchema.safeParse({ reset: true, preset: 'fast' }).success,
    ).toBe(false);
    expect(
      ImageProcessingSaveInputSchema.safeParse({ reset: true, values: values() }).success,
    ).toBe(false);
  });

  it('custom 必带 values（缺失 schema 拒——冻结在 contracts）；带合法 values 过', () => {
    expect(ImageProcessingSaveInputSchema.safeParse({ preset: 'custom' }).success).toBe(false);
    expect(
      ImageProcessingSaveInputSchema.safeParse({ preset: 'custom', values: values() }).success,
    ).toBe(true);
    // custom 携越界 values 同拒（values schema 边界内建）
    expect(
      ImageProcessingSaveInputSchema.safeParse({
        preset: 'custom',
        values: values({ ppcmTarget: 9 }),
      }).success,
    ).toBe(false);
  });

  it('三个固定预设分支：values 可带可不带（服务端按冻结映射生成快照——入参忽略）；未知字段拒', () => {
    expect(ImageProcessingSaveInputSchema.safeParse({ preset: 'fast' }).success).toBe(true);
    expect(ImageProcessingSaveInputSchema.safeParse({ preset: 'balanced' }).success).toBe(true);
    expect(ImageProcessingSaveInputSchema.safeParse({ preset: 'quality' }).success).toBe(true);
    expect(
      ImageProcessingSaveInputSchema.safeParse({ preset: 'fast', values: values({ ppcmTarget: 50 }) }).success,
    ).toBe(true);
    expect(ImageProcessingSaveInputSchema.safeParse({ preset: 'fast', extra: 1 }).success).toBe(false);
  });

  it('preset 枚举外拒', () => {
    expect(ImageProcessingSaveInputSchema.safeParse({ preset: 'turbo' }).success).toBe(false);
    expect(ImageProcessingSaveInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('ImageProcessingSettingsSchema（存储面=档位+快照）', () => {
  it('values 恒在场：custom 缺 values 拒；非 custom 带映射快照过', () => {
    expect(ImageProcessingSettingsSchema.safeParse({ preset: 'custom' }).success).toBe(false);
    expect(ImageProcessingSettingsSchema.safeParse({ preset: 'fast' }).success).toBe(false);
    expect(
      ImageProcessingSettingsSchema.safeParse({
        preset: 'fast',
        values: values({ ppcmTarget: 15, samConfThreshold: 0.5, samMaskMaxSide: 1024 }),
      }).success,
    ).toBe(true);
    expect(
      ImageProcessingSettingsSchema.safeParse({ preset: 'custom', values: values() }).success,
    ).toBe(true);
  });

  it('preset 四值枚举往返（ImageProcessingPresetSchema）', () => {
    const presets: ImageProcessingPreset[] = ['fast', 'balanced', 'quality', 'custom'];
    for (const preset of presets) {
      expect(ImageProcessingPresetSchema.parse(preset)).toBe(preset);
    }
    expect(ImageProcessingPresetSchema.safeParse('magic').success).toBe(false);
  });
});

describe('ImageProcessingGetOutputSchema（读面）', () => {
  it('settings 两态往返：null（未保存）+ 完整快照；source 三值枚举', () => {
    const unsaved = ImageProcessingGetOutputSchema.parse({
      settings: null,
      source: 'default',
      effective: values(),
    });
    expect(unsaved.settings).toBeNull();
    expect(unsaved.source).toBe('default');
    const saved = ImageProcessingGetOutputSchema.parse({
      settings: { preset: 'fast', values: values({ ppcmTarget: 15, samConfThreshold: 0.5, samMaskMaxSide: 1024 }) },
      source: 'settings',
      effective: values({ ppcmTarget: 15, samConfThreshold: 0.5, samMaskMaxSide: 1024 }),
    });
    expect(saved.settings?.preset).toBe('fast');
    expect(saved.effective.samMaskMaxSide).toBe(1024);
    for (const source of ['settings', 'env', 'default'] as const) {
      expect(ImageProcessingGetOutputSchema.safeParse({ settings: null, source, effective: values() }).success).toBe(true);
    }
    expect(
      ImageProcessingGetOutputSchema.safeParse({ settings: null, source: 'legacy', effective: values() }).success,
    ).toBe(false);
  });

  it('env 投影：ppcmTarget（已 clamp 界内）/resampleDisabled 可选在场；越界值拒', () => {
    expect(ImageProcessingEnvStateSchema.parse({})).toEqual({});
    expect(ImageProcessingEnvStateSchema.parse({ ppcmTarget: 40, resampleDisabled: true })).toEqual({
      ppcmTarget: 40,
      resampleDisabled: true,
    });
    expect(ImageProcessingEnvStateSchema.safeParse({ ppcmTarget: 51 }).success).toBe(false);
    expect(
      ImageProcessingGetOutputSchema.parse({
        settings: null,
        source: 'env',
        effective: values({ ppcmTarget: 40 }),
        env: { ppcmTarget: 40, resampleDisabled: true },
      }).env,
    ).toEqual({ ppcmTarget: 40, resampleDisabled: true });
  });
});
