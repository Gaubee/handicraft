/**
 * 引擎 API 化测试（W2.3）：pave（segment→layout，§3.4 参数直通 + region 未知 ID 拒绝）、
 * validate（exportGate ok=true 通过；custom 资产未注册=missing-asset → 任务失败输出
 * violations）、export（SVG/BOM/PNG 三产物 + results 分享包 + task.result 视图）、
 * custom 资产形全链（.gemshape vectorPath 资产渲染入 PNG）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Block, Gem, GridSpec, Palette } from 'rhinestone-studio/engine';
import { decodePng, encodePng } from '../src/png/codec.js';
import { createServices } from './helpers.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitSettled(s: ReturnType<typeof createServices>, taskId: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { task } = await s.jobs.get(s.anonymous, taskId);
    if (task.status !== 'queued' && task.status !== 'running') return task;
    await sleep(25);
  }
  throw new Error('引擎任务未在期限内收敛');
}

/** 测试图：96×96 左半红右半蓝（segment 产出两个色块）。 */
function twoColorPng(): Uint8Array {
  const w = 96;
  const h = 96;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (x < w / 2) {
        rgba[p] = 200; rgba[p + 1] = 16; rgba[p + 2] = 46;
      } else {
        rgba[p] = 16; rgba[p + 1] = 46; rgba[p + 2] = 200;
      }
      rgba[p + 3] = 255;
    }
  }
  return encodePng(w, h, rgba);
}

/** .gemshape 资产（vectorPath 方框形——内容不可变格式最小合法形态）。 */
function gemshapeAsset(name: string): Buffer {
  const tex = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  return Buffer.from(
    JSON.stringify({
      kind: 'gemshape',
      formatVersion: 1,
      appVersion: '0.1.0',
      createdAt: Date.now(),
      savedAt: Date.now(),
      name,
      texture: { mime: 'image/png', dataUrl: tex, width: 1, height: 1 },
      vectorPath: 'M 0.1 0.1 L 0.9 0.1 L 0.9 0.9 L 0.1 0.9 Z',
      physical: { widthMm: 3, heightMm: 3 },
      calibration: { mode: 'direct' },
    }),
    'utf8',
  );
}

function paveParams(overrides: Record<string, unknown> = {}) {
  return {
    op: 'pave' as const,
    imageRef: '',
    strategy: 'hex-pitch' as const,
    gapMm: 0.4,
    spec: { shapeId: 'round' as const, diameterMm: 3 },
    ...overrides,
  };
}

describe('引擎 API 化（W2.3）', () => {
  it('pave：segment→layout 全链——layout.json 产物帧 + done；dropped/钻数日志', async () => {
    const s = createServices();
    try {
      const imageRef = s.blobs.put(twoColorPng()).hash;
      const task = await s.jobs.create(s.anonymous, {
        kind: 'engine',
        params: paveParams({ imageRef }),
      });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('done');
      const frames = s.jobs.frames(s.anonymous, task.taskId, 0).frames;
      const artifact = frames.find((f) => f.kind === 'artifact');
      expect(artifact).toBeDefined();
      const blobRef = (artifact!.payload as { blobRef: string }).blobRef;
      const layoutJson = JSON.parse(s.blobs.read(blobRef)!.toString('utf8')) as {
        gems: Gem[];
        blocks: Block[];
        grid: GridSpec;
        palette: Palette;
      };
      expect(layoutJson.gems.length).toBeGreaterThan(10);
      expect(layoutJson.blocks.length).toBeGreaterThanOrEqual(2); // 红/蓝两块
      expect(layoutJson.grid.pitchMm).toBeCloseTo(3.4);
      // 每钻规格物化（round 3mm）
      for (const gem of layoutJson.gems) {
        expect(gem.shapeId).toBe('round');
        expect(gem.diameterMm).toBe(3);
      }
    } finally {
      s.dispose();
    }
  });

  it('pave：region 未知 ID 显式拒绝（任务失败，错误列出未知 ID）', async () => {
    const s = createServices();
    try {
      const imageRef = s.blobs.put(twoColorPng()).hash;
      const task = await s.jobs.create(s.anonymous, {
        kind: 'engine',
        params: paveParams({
          imageRef,
          region: { kind: 'blocks', ids: ['ghost-block'] },
        }),
      });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('failed');
      expect(final.error).toContain('ghost-block');
    } finally {
      s.dispose();
    }
  });

  it('validate：合规排钻 ok 通过；custom 资产未注册 → exportGate 阻断（missing-asset violations 输出）', async () => {
    const s = createServices();
    try {
      const imageRef = s.blobs.put(twoColorPng()).hash;
      // 合规路径：round 钻
      const pave = await s.jobs.create(s.anonymous, {
        kind: 'engine',
        params: paveParams({ imageRef }),
      });
      await waitSettled(s, pave.taskId);
      const validate = await s.jobs.create(s.anonymous, {
        kind: 'engine',
        params: { op: 'validate', paveTaskId: pave.taskId },
      });
      const validateFinal = await waitSettled(s, validate.taskId);
      expect(validateFinal.status).toBe('done');

      // 阻断路径：custom 钻 + 资产未注册（shapeAssets 缺席）→ missing-asset violation
      const paveCustom = await s.jobs.create(s.anonymous, {
        kind: 'engine',
        params: paveParams({
          imageRef,
          spec: { shapeId: 'custom', diameterMm: 3, assetId: 'ast-unregistered' },
        }),
      });
      await waitSettled(s, paveCustom.taskId);
      const validateCustom = await s.jobs.create(s.anonymous, {
        kind: 'engine',
        params: { op: 'validate', paveTaskId: paveCustom.taskId },
      });
      const customFinal = await waitSettled(s, validateCustom.taskId);
      expect(customFinal.status).toBe('failed');
      expect(customFinal.error).toContain('missing-asset');
      expect(customFinal.error).toContain('ast-unregistered');
    } finally {
      s.dispose();
    }
  });

  it('export：SVG/BOM/PNG 三产物 + results 分享包 + task.result 视图 + custom 资产形渲染', async () => {
    const s = createServices();
    try {
      const imageRef = s.blobs.put(twoColorPng()).hash;
      const assetRef = s.blobs.put(new Uint8Array(gemshapeAsset('方框钻'))).hash;
      const pave = await s.jobs.create(s.anonymous, {
        kind: 'engine',
        params: paveParams({
          imageRef,
          spec: { shapeId: 'custom', diameterMm: 3, assetId: 'ast-square' },
          shapeAssets: { 'ast-square': assetRef },
        }),
      });
      const paveFinal = await waitSettled(s, pave.taskId);
      expect(paveFinal.status).toBe('done');

      const exportTask = await s.jobs.create(s.anonymous, {
        kind: 'engine',
        params: { op: 'export', paveTaskId: pave.taskId },
      });
      const exportFinal = await waitSettled(s, exportTask.taskId);
      expect(exportFinal.status).toBe('done');

      // task.result 视图（bundle 三元组 blobRef + publicId）
      const { task } = await s.jobs.get(s.anonymous, exportTask.taskId);
      expect(task.result).toBeDefined();
      const result = task.result!;
      expect(result.publicId).toMatch(/^[A-Za-z0-9]{12}$/);
      expect(result.bundle.svg).toMatch(/^[0-9a-f]{64}$/);
      expect(result.bundle.bom).toMatch(/^[0-9a-f]{64}$/);
      expect(result.bundle.png).toMatch(/^[0-9a-f]{64}$/);

      // 产物内容：SVG 含 custom 矢量 path（vectorPath 优先）；BOM 含 custom- 规格；PNG 可解码 96×96
      const svg = s.blobs.read(result.bundle.svg)!.toString('utf8');
      expect(svg).toContain('<svg');
      expect(svg).toContain('M 0.1 0.1 L 0.9 0.1'); // vectorPath 直通（矢量优先）
      const bom = s.blobs.read(result.bundle.bom)!.toString('utf8');
      expect(bom).toContain('custom-ast-square');
      const png = decodePng(s.blobs.read(result.bundle.png)!);
      expect(png.width).toBe(96);
      expect(png.height).toBe(96);

      // 分享包目录（bundle 文件 + manifest）
      const bundleDir = path.join(s.config.dataRoot, 'results', result.publicId!);
      expect(existsSync(path.join(bundleDir, 'bundle.json'))).toBe(true);
      expect(existsSync(path.join(bundleDir, 'layout.svg'))).toBe(true);
      expect(existsSync(path.join(bundleDir, 'bom.csv'))).toBe(true);
      expect(existsSync(path.join(bundleDir, 'render.png'))).toBe(true);
      const manifest = JSON.parse(readFileSync(path.join(bundleDir, 'bundle.json'), 'utf8')) as {
        blobRefs: { svg: string };
      };
      expect(manifest.blobRefs.svg).toBe(result.bundle.svg);
    } finally {
      s.dispose();
    }
  });

  it('pave 输入不是 PNG：typed 拒绝（任务失败，PngCodecError 语义消息）', async () => {
    const s = createServices();
    try {
      const imageRef = s.blobs.put(new Uint8Array(Buffer.from('not-a-png'))).hash;
      const task = await s.jobs.create(s.anonymous, {
        kind: 'engine',
        params: paveParams({ imageRef }),
      });
      const final = await waitSettled(s, task.taskId);
      expect(final.status).toBe('failed');
      expect(final.error).toContain('PNG');
    } finally {
      s.dispose();
    }
  });
});
