/**
 * 生成代理测试（W2.2）：dry-run 全链（占位帧+假结果 blob+debug.json 对齐 lab 契约）、
 * 半配置拒绝（spec 场景：只配 baseUrl 未配 key → 创建时拒绝并提示缺哪个键）、
 * 配齐后同参数可创建、settings 表优先双层真源。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../src/png/codec.js';
import { putSetting } from '../src/db/store.js';
import { getTaskById } from '../src/db/jobs.js';
import { clientFor, createServices } from './helpers.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitSettled(services: ReturnType<typeof createServices>, taskId: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { task } = await services.jobs.get(services.anonymous, taskId);
    if (task.status !== 'queued' && task.status !== 'running') return task;
    await sleep(20);
  }
  throw new Error('生成任务未在期限内收敛');
}

describe('生成代理（W2.2）', () => {
  it('dry-run 全链：占位 progress 帧 + 假结果 blob（可解码 PNG）+ debug.json 字段对齐 lab 契约', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const task = await s.jobs.create(s.anonymous, {
        kind: 'generate',
        params: { prompt: '一颗红心，金边', size: '512x512' },
      });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('done');

      const frames = s.jobs.frames(s.anonymous, task.taskId, 0).frames;
      const kinds = frames.map((f) => f.kind);
      expect(kinds).toContain('progress');
      expect(kinds[kinds.length - 1]).toBe('done');
      const artifact = frames.find((f) => f.kind === 'artifact');
      expect(artifact).toBeDefined();
      const blobRef = (artifact!.payload as { blobRef?: string }).blobRef;
      expect(blobRef).toMatch(/^[0-9a-f]{64}$/);
      // 假结果 blob 是真实可解码 PNG（占位图 64×64）
      const bytes = s.blobs.read(blobRef!)!;
      const decoded = decodePng(bytes);
      expect(decoded.width).toBe(64);
      expect(decoded.height).toBe(64);

      // debug.json：字段对齐 lab ImageTaskDebug（endpoint/requestBody/durationMs）
      const debugPath = path.join(s.config.dataRoot, 'tasks', task.taskId, 'debug.json');
      expect(existsSync(debugPath)).toBe(true);
      const debug = JSON.parse(readFileSync(debugPath, 'utf8')) as Record<string, unknown>;
      expect(debug['endpoint']).toContain('dry-run');
      expect((debug['requestBody'] as Record<string, unknown>)['dryRun']).toBe(true);
      expect('durationMs' in debug).toBe(true);

      // 同 prompt 幂等内容（占位图确定性——同 prompt 同 blob）
      const task2 = await s.jobs.create(s.anonymous, {
        kind: 'generate',
        params: { prompt: '一颗红心，金边' },
      });
      await waitSettled(s, task2.taskId);
      const frames2 = s.jobs.frames(s.anonymous, task2.taskId, 0).frames;
      const artifact2 = frames2.find((f) => f.kind === 'artifact')!;
      expect((artifact2.payload as { blobRef: string }).blobRef).toBe(blobRef);
    } finally {
      s.dispose();
    }
  });

  it('半配置拒绝（spec 场景）：只配 baseUrl 未配 key → 创建显式拒绝并提示缺 IMG_API_KEY；dry-run 开启时不拒', async () => {
    const s = createServices(undefined, { imgDryRun: false });
    try {
      // .env 面半配置（baseUrl 有、key/model 无）
      s.config.img.baseUrl = 'https://img.example.com/v1';
      await expect(
        s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } }),
      ).rejects.toThrow(/缺 IMG_API_KEY、IMG_MODEL/);

      // settings 表优先（双层真源）：补齐后同参数任务可创建。baseUrl 指 loopback 死端口
      // （127.0.0.1:1——连接立即拒绝，无任何真实外呼；本测试只断言创建不再被半配置拒绝）
      putSetting(s.db, 'img_api_key', 'sk-live');
      putSetting(s.db, 'img_model', 'img-x');
      s.config.img.baseUrl = 'http://127.0.0.1:1/v1';
      const task = await s.jobs.create(s.anonymous, { kind: 'generate', params: { prompt: 'p' } });
      s.jobs.cancel(s.anonymous, task.taskId);
      expect(getTaskById(s.db, task.taskId)).not.toBeNull();
    } finally {
      s.dispose();
    }
  });

  it('RPC 面：dry-run 旗标经 bootstrap 下发；生成任务经 router 可创建', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const token = await s.tokenFor();
      const client = clientFor(s.context({ token }));
      const boot = await client.bootstrap();
      expect(boot.imgDryRun).toBe(true);
      expect(boot.imgConfigured).toBe(false);
      const created = await client.tasks.create({
        kind: 'generate',
        params: { prompt: 'via-rpc' },
      });
      expect(created.kind).toBe('generate');
      await waitSettled(s, created.taskId);
      const { task } = await client.tasks.get({ taskId: created.taskId });
      expect(task.status).toBe('done');
    } finally {
      s.dispose();
    }
  });
});
