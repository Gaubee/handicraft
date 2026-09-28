/**
 * imageProcessing RPC 集成测试（add-image-processing-settings tasks 1.3 / design
 * §4）：createRouterClient 直调（不穿 WS——rpc.test.ts 同模式），真 sqlite+真
 * handler。覆盖：未保存 get 返回 source=default+effective=性能档映射 / save fast
 * 快照往返（values=冻结映射值，入参 values 被覆盖）/ save custom 越界 orpc input
 * 层 typed 拒 / custom 缺 values store 层 typed 拒 / reset 后回 default / requireActiveUser
 * 守卫（无 token 401）。
 */
import { describe, expect, it } from 'vitest';
import { ORPCError } from '@orpc/server';
import { IMAGE_PROCESSING_PRESET_VALUES } from '../src/image-processing-store.js';
import { clientFor, createServices } from './helpers.js';

async function expectOrpcError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe(code);
    return;
  }
  throw new Error(`预期抛出 ORPCError（${code}）`);
}

describe('imageProcessing.{get,save}（requireActiveUser，models 端点同构）', () => {
  it('requireActiveUser：无 token 的 get 401；带 token 可读', async () => {
    const s = createServices();
    try {
      await expectOrpcError(clientFor(s.context()).imageProcessing.get(), 'UNAUTHORIZED');
      const token = await s.tokenFor();
      const out = await clientFor(s.context({ token })).imageProcessing.get();
      expect(out.source).toBe('default');
    } finally {
      s.dispose();
    }
  });

  it('未保存 get：source=default + effective=性能档映射（25/true/0.40/null），settings=null', async () => {
    const s = createServices();
    try {
      const token = await s.tokenFor();
      const out = await clientFor(s.context({ token })).imageProcessing.get();
      expect(out).toEqual({
        settings: null,
        source: 'default',
        effective: { ...IMAGE_PROCESSING_PRESET_VALUES.balanced },
      });
    } finally {
      s.dispose();
    }
  });

  it('save fast：快照往返（values=冻结映射值）；入参 values 被映射覆盖；写后 env 语义真源', async () => {
    const s = createServices();
    try {
      const token = await s.tokenFor();
      const client = clientFor(s.context({ token }));
      const saved = await client.imageProcessing.save({
        preset: 'fast',
        // 篡改 values 入参——服务端忽略，按冻结映射快照落库
        values: { ppcmTarget: 50, resampleEnabled: false, samConfThreshold: 0.95, samMaskMaxSide: 2048 },
      });
      expect(saved.source).toBe('settings');
      expect(saved.settings).toEqual({
        preset: 'fast',
        values: { ...IMAGE_PROCESSING_PRESET_VALUES.fast },
      });
      expect(saved.effective).toEqual({ ...IMAGE_PROCESSING_PRESET_VALUES.fast });
      // get 读回一致（settings 真源）
      const reread = await client.imageProcessing.get();
      expect(reread).toEqual(saved);
    } finally {
      s.dispose();
    }
  });

  it('save custom：合法 values 落库；越界（ppcm=9/conf=0.96/maskMaxSide=31）orpc input 层 typed 拒', async () => {
    const s = createServices();
    try {
      const token = await s.tokenFor();
      const client = clientFor(s.context({ token }));
      const custom = await client.imageProcessing.save({
        preset: 'custom',
        values: { ppcmTarget: 18, resampleEnabled: true, samConfThreshold: 0.35, samMaskMaxSide: null },
      });
      expect(custom.settings).toEqual({
        preset: 'custom',
        values: { ppcmTarget: 18, resampleEnabled: true, samConfThreshold: 0.35, samMaskMaxSide: null },
      });
      expect(custom.effective.ppcmTarget).toBe(18);

      await expectOrpcError(
        client.imageProcessing.save({
          preset: 'custom',
          values: { ppcmTarget: 9, resampleEnabled: true, samConfThreshold: 0.4, samMaskMaxSide: null },
        }),
        'BAD_REQUEST',
      );
      await expectOrpcError(
        client.imageProcessing.save({
          preset: 'custom',
          values: { ppcmTarget: 25, resampleEnabled: true, samConfThreshold: 0.96, samMaskMaxSide: null },
        }),
        'BAD_REQUEST',
      );
      await expectOrpcError(
        client.imageProcessing.save({
          preset: 'custom',
          values: { ppcmTarget: 25, resampleEnabled: true, samConfThreshold: 0.4, samMaskMaxSide: 31 },
        }),
        'BAD_REQUEST',
      );
      // 越界写不入库（上次合法保存仍在）
      const after = await client.imageProcessing.get();
      expect(after.settings?.values.ppcmTarget).toBe(18);
    } finally {
      s.dispose();
    }
  });

  it('save custom 缺 values：store 层 typed 拒（BAD_REQUEST）；reset 后回 default', async () => {
    const s = createServices();
    try {
      const token = await s.tokenFor();
      const client = clientFor(s.context({ token }));
      await client.imageProcessing.save({ preset: 'quality' });
      // 契约联合分支结构放行（values 可选），语义校验在 daemon store——typed 拒
      await expectOrpcError(client.imageProcessing.save({ preset: 'custom' } as never), 'BAD_REQUEST');
      const reset = await client.imageProcessing.save({ reset: true });
      expect(reset).toEqual({
        settings: null,
        source: 'default',
        effective: { ...IMAGE_PROCESSING_PRESET_VALUES.balanced },
      });
    } finally {
      s.dispose();
    }
  });
});
