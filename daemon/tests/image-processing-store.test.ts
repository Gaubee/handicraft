/**
 * image-processing-store 单测（add-image-processing-settings tasks 1.2 / design §3）：
 * 双层真源解析（settings→env→default 单源）、预设冻结映射快照落库（非 custom 入参
 * values 被映射覆盖——防客户端篡改）、custom 缺 values contracts schema 拒（P2-2
 * 起冻结在联合分支）、env 越界 clamp/坏值落 25（resolveIntakeResampleConfig 同款）、
 * 坏 JSON 容错按未写入+P3 warn 诊断、reset 删键回落 env/default 跟随、写后真源
 * （env 改动不漂移）。
 * db 构造比照 src/models-store.test.ts（temp DATA_ROOT + openDatabase）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageProcessingSaveInputSchema } from '@handicraft/contracts';
import { openDatabase, type SqliteDb } from '../src/db/database.js';
import { getSetting, putSetting } from '../src/db/store.js';
import {
  IMAGE_PROCESSING_PRESET_VALUES,
  imageProcessingEffective,
  loadImageProcessing,
  saveImageProcessing,
} from '../src/image-processing-store.js';

const dirs: string[] = [];
function tempDb(): SqliteDb {
  const dir = mkdtempSync(path.join(tmpdir(), 'handicraft-imgproc-'));
  dirs.push(dir);
  return openDatabase(dir);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 性能档映射（缺省 effective——design §1 balanced 冻结值）。 */
const BALANCED = IMAGE_PROCESSING_PRESET_VALUES.balanced;

describe('读面：双层真源解析单源', () => {
  it('未写入无 env → source=default，effective=性能档映射，settings=null', () => {
    const db = tempDb();
    const out = loadImageProcessing(db, {});
    expect(out).toEqual({ settings: null, source: 'default', effective: { ...BALANCED } });
    expect(imageProcessingEffective(db, {})).toEqual({ ...BALANCED });
  });

  it('未写随 env：PPCM_TARGET=40 → effective.ppcmTarget=40、source=env、env 投影在场', () => {
    const db = tempDb();
    const out = loadImageProcessing(db, { PPCM_TARGET: '40' });
    expect(out.source).toBe('env');
    expect(out.settings).toBeNull();
    expect(out.effective.ppcmTarget).toBe(40);
    // SAM 两字段无 env 键=回落性能档映射
    expect(out.effective.samConfThreshold).toBe(BALANCED.samConfThreshold);
    expect(out.effective.samMaskMaxSide).toBeNull();
    expect(out.env).toEqual({ ppcmTarget: 40 });
  });

  it('PPCM_RESAMPLE=0 在场 → source=env、resampleEnabled=false、env.resampleDisabled=true', () => {
    const db = tempDb();
    const out = loadImageProcessing(db, { PPCM_RESAMPLE: '0' });
    expect(out.source).toBe('env');
    expect(out.effective.resampleEnabled).toBe(false);
    // PPCM_TARGET 缺席→ppcmTarget=缺省 25（resolveIntakeResampleConfig 同款）
    expect(out.effective.ppcmTarget).toBe(25);
    expect(out.env).toEqual({ resampleDisabled: true });
    // PPCM_RESAMPLE=1：env 在场但开关开、投影不携 resampleDisabled
    const on = loadImageProcessing(db, { PPCM_RESAMPLE: '1' });
    expect(on.source).toBe('env');
    expect(on.effective.resampleEnabled).toBe(true);
    expect(on.env).toEqual({});
  });

  it('env 越界 clamp、坏值落 25：5→10、999→50、abc+PPCM_RESAMPLE 在场→25', () => {
    const db = tempDb();
    expect(loadImageProcessing(db, { PPCM_TARGET: '5' }).effective.ppcmTarget).toBe(10);
    expect(loadImageProcessing(db, { PPCM_TARGET: '999' }).effective.ppcmTarget).toBe(50);
    expect(loadImageProcessing(db, { PPCM_TARGET: '37.9' }).effective.ppcmTarget).toBe(37);
    // PPCM_TARGET 不可解析单独在场 → env 不在场（default）；携 PPCM_RESAMPLE 才算 env 源（坏值落 25）
    expect(loadImageProcessing(db, { PPCM_TARGET: 'abc' }).source).toBe('default');
    const viaResample = loadImageProcessing(db, { PPCM_TARGET: 'abc', PPCM_RESAMPLE: '1' });
    expect(viaResample.source).toBe('env');
    expect(viaResample.effective.ppcmTarget).toBe(25);
    expect(viaResample.env).toEqual({});
  });

  it('坏 JSON/不符 schema 容错：按未写入（default），不 throw；P3 留 warn 诊断（键名+原因）', () => {
    const db = tempDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      putSetting(db, 'image_processing', '{oops 未闭合');
      expect(loadImageProcessing(db, {}).source).toBe('default');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('image_processing'); // 键名在诊断里
      expect(String(warn.mock.calls[0]![0])).toContain('JSON'); // 原因简述
      // 合法 JSON 但不符 ImageProcessingSettingsSchema（缺 values）→ 同按未写入+warn
      putSetting(db, 'image_processing', JSON.stringify({ preset: 'fast' }));
      expect(loadImageProcessing(db, {}).source).toBe('default');
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1]![0])).toContain('schema');
      // 无键/合法保存路径零 warn（正常面不刷诊断）
      warn.mockClear();
      expect(loadImageProcessing(tempDb(), {}).source).toBe('default');
      saveImageProcessing(db, { preset: 'fast' }, {});
      expect(loadImageProcessing(db, {}).source).toBe('settings');
      expect(warn).not.toHaveBeenCalled();
      expect(imageProcessingEffective(db, {})).toEqual({ ...IMAGE_PROCESSING_PRESET_VALUES.fast });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('写面：保存语义与快照', () => {
  it('保存 fast → settings 真源+values=冻结映射快照；之后改 env 不漂移', () => {
    const db = tempDb();
    const saved = saveImageProcessing(db, { preset: 'fast' }, { PPCM_TARGET: '40' });
    expect(saved.source).toBe('settings');
    expect(saved.settings).toEqual({ preset: 'fast', values: { ...IMAGE_PROCESSING_PRESET_VALUES.fast } });
    expect(saved.effective).toEqual({ ...IMAGE_PROCESSING_PRESET_VALUES.fast });
    // env 改动不漂移（settings 真源——env 不参与）
    const after = loadImageProcessing(db, { PPCM_TARGET: '40', PPCM_RESAMPLE: '0' });
    expect(after.source).toBe('settings');
    expect(after.effective.ppcmTarget).toBe(15);
    expect(after.effective.resampleEnabled).toBe(true);
    expect(after.env).toBeUndefined();
  });

  it('非 custom 入参 values 被映射覆盖（防篡改）；custom 带缺省外值原样落库', () => {
    const db = tempDb();
    const tampered = saveImageProcessing(
      db,
      {
        preset: 'quality',
        values: { ppcmTarget: 10, resampleEnabled: false, samConfThreshold: 0.95, samMaskMaxSide: 2048 },
      },
      {},
    );
    expect(tampered.settings?.values).toEqual({ ...IMAGE_PROCESSING_PRESET_VALUES.quality });
    expect(getSetting(db, 'image_processing')).toBe(
      JSON.stringify({ preset: 'quality', values: IMAGE_PROCESSING_PRESET_VALUES.quality }),
    );

    const custom = saveImageProcessing(
      db,
      { preset: 'custom', values: { ppcmTarget: 12, resampleEnabled: false, samConfThreshold: 0.6, samMaskMaxSide: 512 } },
      {},
    );
    expect(custom.source).toBe('settings');
    expect(custom.effective).toEqual({
      ppcmTarget: 12,
      resampleEnabled: false,
      samConfThreshold: 0.6,
      samMaskMaxSide: 512,
    });
  });

  it('custom 缺 values → contracts schema 拒（P2-2 冻结在联合分支——store 面类型不可达）', () => {
    const db = tempDb();
    expect(ImageProcessingSaveInputSchema.safeParse({ preset: 'custom' }).success).toBe(false);
    // reset 混入 preset 同拒（.strict() 联合分支）
    expect(ImageProcessingSaveInputSchema.safeParse({ reset: true, preset: 'fast' }).success).toBe(false);
    // 未落库（schema 拒=请求根本到不了 store）
    expect(getSetting(db, 'image_processing')).toBeNull();
  });

  it('reset：删 settings 键 → 回 env/default 跟随（键真删除）', () => {
    const db = tempDb();
    saveImageProcessing(db, { preset: 'fast' }, {});
    expect(getSetting(db, 'image_processing')).not.toBeNull();
    // env 在场 → reset 后回 env
    const backToEnv = saveImageProcessing(db, { reset: true }, { PPCM_TARGET: '40' });
    expect(backToEnv.source).toBe('env');
    expect(backToEnv.settings).toBeNull();
    expect(backToEnv.effective.ppcmTarget).toBe(40);
    expect(getSetting(db, 'image_processing')).toBeNull();
    // env 缺席 → reset 后回 default
    saveImageProcessing(db, { preset: 'quality' }, {});
    const backToDefault = saveImageProcessing(db, { reset: true }, {});
    expect(backToDefault).toEqual({ settings: null, source: 'default', effective: { ...BALANCED } });
    // 幂等：未保存时 reset 无害
    expect(saveImageProcessing(db, { reset: true }, {}).source).toBe('default');
  });

  it('imageProcessingEffective 与读面同源（内部消费面——调用时解析不缓存）', () => {
    const db = tempDb();
    expect(imageProcessingEffective(db, { PPCM_TARGET: '45' }).ppcmTarget).toBe(45);
    saveImageProcessing(db, { preset: 'fast' }, { PPCM_TARGET: '45' });
    expect(imageProcessingEffective(db, { PPCM_TARGET: '45' }).ppcmTarget).toBe(15);
  });
});
