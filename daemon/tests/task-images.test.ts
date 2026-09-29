/**
 * W5 走查 P0-1 修复回归（物料桥哈希断裂——PNG 场景 agent 死锁）。
 * 原始需求 2026-09-28：上传图片经 dsh saveImages（sharp 规范化）重编码后，agent
 * 可见附件引用（重编码后 sha）≠ daemon blobRef（原始字节 sha）→ agent 调
 * scene.analyze/subject.segment 传错 ref（image-missing）。修复=双通道：
 *   [1] 首条 followup prompt 锚注扩为 imageId→blobRef 映射（kernel/index.ts）；
 *   [2] MCP 只读工具 studio.task.images.list（capability/task-images.ts——task-stones
 *       readonly 面同形）。
 * 覆盖：prompt 锚注内容；工具注册（kernel 组合面+MCP 投影+deny 名单放行）；工具
 * 输出（多图映射/空图集/后续轮次同图集/blob 缺失降级）；probeImageSize 三格式
 * 魔数级尺寸探测。fake 内核 harness（project-first-followup.test.ts 同模式）。
 */
import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { encodePng } from '../src/png/codec.js';
import { recordBlobUpload } from '../src/db/blobs.js';
import { createAgentTask } from '../src/db/jobs.js';
import { HandicraftKernel } from '../src/kernel/index.js';
import { createTaskImagesCapabilities, TASK_IMAGES_LIST_TOOL_NAME } from '../src/capability/task-images.js';
import { mcpToolName } from '../src/capability/mcp.js';
import { productToolDenyList } from '../src/kernel/tool-surface.js';
import { probeImageSize, sniffImageMime } from '../src/image-sniff.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixtures

/** 附件 PNG（魔数嗅探面+尺寸探测面——8×6 纯色即可）。 */
function pngBytes(width = 8, height = 6): Uint8Array {
  const rgba = new Uint8Array(width * height * 4).fill(255);
  return new Uint8Array(encodePng(width, height, rgba));
}

/** 最小 JPEG 头（SOF0 段携带 9×7 尺寸——probe 扫描面用，非解码）。 */
function jpegBytes(width = 9, height = 7): Uint8Array {
  const bytes = new Uint8Array(64).fill(0xff);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0); // SOI + APP0 段（length=16）
  const sof = 2 + 2 + 16; // APP0 段尾（SOI 2 字节 + 段长 2 + length 16）=18
  bytes.set(
    [0xff, 0xc0, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x01, 0x11, 0x00],
    sof,
  ); // SOF0：precision/height/width/组件数
  return bytes;
}

/** 最小 WebP 容器（VP8X 头携带 10×5 canvas 尺寸——probe 面用）。 */
function webpBytes(width = 10, height = 5): Uint8Array {
  const bytes = new Uint8Array(34).fill(0);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  const w1 = width - 1;
  const h1 = height - 1;
  bytes.set([w1 & 0xff, (w1 >> 8) & 0xff, (w1 >> 16) & 0xff], 24);
  bytes.set([h1 & 0xff, (h1 >> 8) & 0xff, (h1 >> 16) & 0xff], 27);
  return bytes;
}

function uploadPng(s: TestServices, ownerId: string, bytes: Uint8Array = pngBytes()): string {
  const hash = s.blobs.put(bytes).hash;
  recordBlobUpload(s.db, hash, ownerId);
  return hash;
}

/** fake 内核 harness（不 boot dsh）：捕获首条 prompt（agent.followup 消息）。 */
function promptCapturingKernel(s: TestServices): { kernel: HandicraftKernel; prompts: string[] } {
  const prompts: string[] = [];
  const agent = {
    session: { id: '' },
    status: 'idle',
    followup(message: unknown): void {
      const content = (message as { content: Array<{ type: string; text?: string }> }).content;
      prompts.push(
        content
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n'),
      );
    },
    steer(): void {},
    inject(): void {},
    cancel(): void {},
    whenIdle: () => Promise.resolve(),
    inbox: { nextTurn: [], nextStep: [], remove: () => false, replace: () => false, splice: () => [] },
  };
  const handle = {
    ctx: {
      on: () => () => undefined,
      agents: {
        create: async (options: { sessionId: string; setup?: (agentCtx: Context) => void }) => {
          agent.session.id = options.sessionId;
          options.setup?.({
            tools: { schemas: () => [{ name: 'bash' }], restrict: () => () => undefined },
          } as unknown as Context);
          return { agent, dispose: async () => undefined };
        },
      },
      attachments: {
        saveImages: async (inputs: ReadonlyArray<{ data: Uint8Array }>) =>
          inputs.map((input, index) => ({ attachmentId: `att-${index}`, width: 8, height: 6, bytes: input.data.byteLength })),
      },
    },
    record: { entries: [], activationOrder: [], inactiveActivation: [] },
    globalToolNames: () => [] as string[],
    dispose: async () => undefined,
  };
  const kernel = new HandicraftKernel({ config: s.config, db: s.db, jobs: s.jobs, sessions: s.sessions, blobs: s.blobs });
  const hack = kernel as unknown as { state: string; handle: unknown };
  hack.state = 'ready';
  hack.handle = handle;
  return { kernel, prompts };
}

// ---------------------------------------------------------------- [1] prompt 锚注

describe('W5 P0-1 通道一：首条 followup prompt 锚注 imageId→blobRef 映射', () => {
  it('首条两图：prompt 含 image-1=<hash1>、image-2=<hash2> 与工具入参指引', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const { kernel, prompts } = promptCapturingKernel(s);
      const hash1 = uploadPng(s, s.anonymous.id);
      const hash2 = uploadPng(s, s.anonymous.id);
      const { sessionId } = s.sessions.create(s.anonymous, { title: '锚注' });
      await kernel.followup(s.anonymous, sessionId, { text: '排这两张', attachments: [hash1, hash2] });
      expect(prompts).toHaveLength(1);
      const prompt = prompts[0]!;
      expect(prompt).toContain('排这两张');
      expect(prompt).toContain(`[任务绑定 taskId=`);
      // 映射锚注（P0-1 裁定形态）：imageId=blobRef 成对、按输入顺序。
      expect(prompt).toContain(`image-1=${hash1}`);
      expect(prompt).toContain(`image-2=${hash2}`);
      expect(prompt).toContain('imageBlobRef 入参一律用这里的 blobRef');
      expect(prompt).toContain('studio.task.images.list');
      // 后续轮次附件=讨论插图：不携带映射（只有数量说明）。
      const hash3 = uploadPng(s, s.anonymous.id);
      await kernel.followup(s.anonymous, sessionId, { text: '补参考图', attachments: [hash3] });
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('讨论插图');
      expect(prompts[1]).not.toContain(`image-1=${hash3}`);
      await kernel.stop();
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [2] 工具面

describe('W5 P0-1 通道二：studio.task.images.list 工具面', () => {
  it('kernel 组合面注册（26 工具面+1）+MCP 投影名过 deny 名单', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const { kernel } = promptCapturingKernel(s);
      expect(kernel.capabilities.names()).toContain(TASK_IMAGES_LIST_TOOL_NAME);
      expect(mcpToolName(TASK_IMAGES_LIST_TOOL_NAME)).toBe('task_images_list');
      expect(productToolDenyList([`mcp__studio__${mcpToolName(TASK_IMAGES_LIST_TOOL_NAME)}`, 'bash'])).toEqual(['bash']);
      await kernel.stop();
    } finally {
      s.dispose();
    }
  });

  it('多图映射输出：imageId/blobRef/name/mime/width/height（首条两图 PNG）', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const hash1 = uploadPng(s, s.anonymous.id, pngBytes(8, 6));
      const hash2 = uploadPng(s, s.anonymous.id, pngBytes(4, 3));
      const { sessionId } = s.sessions.create(s.anonymous, { title: '图集' });
      const registry = createTaskImagesCapabilities({ db: s.db, blobs: s.blobs });
      // 造首条 task 行（params 审计=followup 建行面同形）。
      createAgentTask(s.db, {
        ownerId: s.anonymous.id,
        sessionId,
        status: 'running',
        paramsJson: JSON.stringify({
          text: '两张主图',
          attachments: [hash1, hash2],
          imageIds: ['image-1', 'image-2'],
        }),
      });
      const result = await registry.call(TASK_IMAGES_LIST_TOOL_NAME, { taskId: 'nope' }, 'agent');
      expect(result).toMatchObject({ kind: 'failed' });
      // 经 kernel followup 建真实行（审计面同真源），再查工具。
      const { kernel } = promptCapturingKernel(s);
      const { sessionId: sid2 } = s.sessions.create(s.anonymous, { title: '工具查询' });
      const hash3 = uploadPng(s, s.anonymous.id, pngBytes(12, 9));
      const { taskId } = await kernel.followup(s.anonymous, sid2, { text: '一张', attachments: [hash3] });
      const outcome = await kernel.capabilities.call(TASK_IMAGES_LIST_TOOL_NAME, { taskId }, 'agent');
      expect(outcome).toMatchObject({ kind: 'ok' });
      const value = (outcome as { kind: 'ok'; value: { images: Array<Record<string, unknown>> } }).value;
      expect(value.images).toHaveLength(1);
      expect(value.images[0]).toMatchObject({
        imageId: 'image-1',
        blobRef: hash3,
        mime: 'image/png',
        width: 12,
        height: 9,
      });
      expect(String(value.images[0]!['name'])).toMatch(/^attachment-[0-9a-f]{12}\.png$/);
      // 后续轮次 task 查同一图集（会话锚——任意轮次同投影）。
      const second = await kernel.followup(s.anonymous, sid2, { text: '第二轮（无图）' });
      const again = await kernel.capabilities.call(TASK_IMAGES_LIST_TOOL_NAME, { taskId: second.taskId }, 'agent');
      expect((again as { kind: 'ok'; value: { images: unknown[] } }).value.images).toHaveLength(1);
      await kernel.stop();
      // 独立会话多图行直查（fake 行路径）。
      const direct = await createTaskImagesCapabilities({ db: s.db, blobs: s.blobs }).call(
        TASK_IMAGES_LIST_TOOL_NAME,
        { taskId: taskRowIdOf(s, sessionId) },
        'agent',
      );
      const images = (direct as { kind: 'ok'; value: { images: Array<Record<string, unknown>> } }).value.images;
      expect(images.map((image) => [image['imageId'], image['blobRef']])).toEqual([
        ['image-1', hash1],
        ['image-2', hash2],
      ]);
      expect(images[0]).toMatchObject({ mime: 'image/png', width: 8, height: 6 });
      expect(images[1]).toMatchObject({ mime: 'image/png', width: 4, height: 3 });
    } finally {
      s.dispose();
    }
  });

  it('无主图集会话=空清单+note；blob 缺失行降级 null 尺寸；非 agent 任务 typed 拒', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const { kernel } = promptCapturingKernel(s);
      const { sessionId } = s.sessions.create(s.anonymous, { title: '无图' });
      const { taskId } = await kernel.followup(s.anonymous, sessionId, { text: '纯文本首条' });
      const empty = await kernel.capabilities.call(TASK_IMAGES_LIST_TOOL_NAME, { taskId }, 'agent');
      expect(empty).toMatchObject({ kind: 'ok' });
      expect((empty as { kind: 'ok'; value: { images: unknown[]; note: string } }).value.images).toEqual([]);

      // blob 缺失（登记后物理删除——blob 行在而字节不可读的窗口）：mime/尺寸降级 null。
      const { sessionId: sid2 } = s.sessions.create(s.anonymous, { title: '缺字节' });
      const orphan = 'a'.repeat(64);
      const row = createAgentTask(s.db, {
        ownerId: s.anonymous.id,
        sessionId: sid2,
        status: 'running',
        paramsJson: JSON.stringify({ text: 'x', attachments: [orphan], imageIds: ['image-1'] }),
      });
      const degraded = await createTaskImagesCapabilities({ db: s.db, blobs: s.blobs }).call(
        TASK_IMAGES_LIST_TOOL_NAME,
        { taskId: row.id },
        'agent',
      );
      const images = (degraded as { kind: 'ok'; value: { images: Array<Record<string, unknown>> } }).value.images;
      expect(images[0]).toMatchObject({ imageId: 'image-1', blobRef: orphan, mime: null, width: null, height: null });

      // 非 agent 任务：typed 拒（failed 闭合）。
      const jobTask = await s.jobs.create(s.anonymous, { kind: 'sleep', params: { durationMs: 1 } });
      const rejected = await createTaskImagesCapabilities({ db: s.db, blobs: s.blobs }).call(
        TASK_IMAGES_LIST_TOOL_NAME,
        { taskId: jobTask.taskId },
        'agent',
      );
      expect(rejected).toMatchObject({ kind: 'failed' });
      await kernel.stop();
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [3] 尺寸探测

describe('probeImageSize（魔数级三格式）', () => {
  it('PNG IHDR / JPEG SOF / WebP VP8X 声明尺寸；与 sniff 配对', () => {
    expect(sniffImageMime(pngBytes(8, 6))).toBe('image/png');
    expect(probeImageSize(pngBytes(8, 6), 'image/png')).toEqual({ width: 8, height: 6 });
    expect(sniffImageMime(jpegBytes(9, 7))).toBe('image/jpeg');
    expect(probeImageSize(jpegBytes(9, 7), 'image/jpeg')).toEqual({ width: 9, height: 7 });
    expect(sniffImageMime(webpBytes(10, 5))).toBe('image/webp');
    expect(probeImageSize(webpBytes(10, 5), 'image/webp')).toEqual({ width: 10, height: 5 });
    // 字节过短=声明缺失 → null（不猜）。
    expect(probeImageSize(pngBytes(8, 6).slice(0, 10), 'image/png')).toBeNull();
    expect(probeImageSize(new Uint8Array(8), 'image/jpeg')).toBeNull();
  });
});

/** 会话首个 agent task 的 id（fake 行直查辅助）。 */
function taskRowIdOf(s: TestServices, sessionId: string): string {
  const row = s.db
    .prepare("SELECT id FROM tasks WHERE session_id = ? AND type = 'agent' ORDER BY created_at, rowid LIMIT 1")
    .get(sessionId) as { id: string } | undefined;
  if (!row) throw new Error('no agent task row');
  return row.id;
}
