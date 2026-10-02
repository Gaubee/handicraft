/**
 * 断点账本单测（add-segment-checkpoint-resume tasks 5.1——segment-ledger.ts 纯函数
 * 与 IO 面全覆盖）。覆盖：
 *   [1] canonicalJson：键序递归消化（对象键序/嵌套数组内对象序漂移=同串）；undefined
 *       键吸收（不发字段=服务端缺省语义等价）。
 *   [2] 指纹稳定性：同输入同 fp；任一锚点（imageBlobRef/imagePx/canvasCm）或元素
 *       清单变 → fp 变；元素对象键序漂移 → fp 不变。
 *   [3] reqHash 投影（R1-P0-1）：taskId 变 → hash 不变（跨任务命中依据）；prompt/
 *       iteration/confThreshold/maskMaxSide 变 → hash 变；kind 变 → hash 变。
 *   [4] append/load 往返：segment/analyze 双行、header 首行审计、内存 Map 即时命中
 *       （append 后不重读文件即 get 命中）。
 *   [5] 容错：坏尾行（崩溃半行）跳过；坏 blobRef 行（掩码 blob 已释放）跳过；
 *       同 reqHash 多行首行制。
 *   [6] GC：mtime 超龄清扫（注入 now——确定性）；新鲜保留；env 天数解析。
 * 零外呼零常驻进程（本地 tmp DATA_ROOT）。
 */
import { utimesSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SceneElement } from '@handicraft/contracts';
import { makeAnalyzeRequest, makeSegmentRequest } from '../src/kernel/vision/sam-bridge.js';
import {
  canonicalJson,
  gcSegmentLedgers,
  parseSegmentLedgerLine,
  segmentLedgerFingerprint,
  segmentLedgerGcDays,
  SegmentLedger,
  segmentRequestHash,
  SEGMENT_LEDGERS_DIRNAME,
} from '../src/kernel/vision/segment-ledger.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

const ANCHORS = {
  imageBlobRef: 'a'.repeat(64),
  imagePx: { width: 96, height: 96 },
  canvasCm: { w: 10, h: 10 },
} as const;

function elements(): SceneElement[] {
  return [
    {
      name: '花束',
      category: 'flower',
      boxPx: { x: 10, y: 8, w: 70, h: 66 },
      hint: 'bouquet',
      suggestDrillWorthy: true,
    },
    {
      name: '缎带',
      category: 'object',
      boxPx: { x: 4, y: 80, w: 88, h: 12 },
      hint: 'ribbon',
      suggestDrillWorthy: true,
    },
  ];
}

const FIXED_NOW = (): string => '2026-10-02T00:00:00.000Z';

function ledgerOf(s: TestServices, fp = segmentLedgerFingerprint({ ...ANCHORS, elements: elements() })) {
  return SegmentLedger.load({ dataRoot: s.config.dataRoot, blobs: s.blobs, now: FIXED_NOW }, fp, 'task-a');
}

function ledgerPath(s: TestServices, fp: string): string {
  return path.join(s.config.dataRoot, SEGMENT_LEDGERS_DIRNAME, `${fp}.jsonl`);
}

function segReq(overrides: { taskId?: string; text?: string; iteration?: number; confThreshold?: number; maskMaxSide?: number } = {}) {
  return makeSegmentRequest({
    taskId: overrides.taskId ?? 'task-a',
    imageBlobRef: ANCHORS.imageBlobRef,
    imagePx: ANCHORS.imagePx,
    canvasCm: ANCHORS.canvasCm,
    prompt: { kind: 'text', text: overrides.text ?? 'bouquet as a whole' },
    iteration: overrides.iteration ?? 0,
    ...(overrides.confThreshold !== undefined ? { confThreshold: overrides.confThreshold } : {}),
    ...(overrides.maskMaxSide !== undefined ? { maskMaxSide: overrides.maskMaxSide } : {}),
  });
}

// ---------------------------------------------------------------- [1] canonicalJson

describe('segment-ledger canonicalJson', () => {
  it('键序递归消化：对象/嵌套数组内对象键序漂移=同串', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 3, y: 4 }], c: 'x' } })).toBe(
      canonicalJson({ a: { c: 'x', d: [2, { y: 4, z: 3 }] }, b: 1 }),
    );
  });

  it('undefined 键吸收（不发字段=缺省语义等价）；数组序不消化（序是语义）', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

// ---------------------------------------------------------------- [2] 指纹

describe('segment-ledger 指纹稳定性', () => {
  it('同输入同 fp；任一锚点/元素变 → fp 变', () => {
    const base = segmentLedgerFingerprint({ ...ANCHORS, elements: elements() });
    expect(segmentLedgerFingerprint({ ...ANCHORS, elements: elements() })).toBe(base);
    expect(segmentLedgerFingerprint({ ...ANCHORS, imageBlobRef: 'b'.repeat(64), elements: elements() })).not.toBe(base);
    expect(segmentLedgerFingerprint({ ...ANCHORS, imagePx: { width: 48, height: 48 }, elements: elements() })).not.toBe(base);
    expect(segmentLedgerFingerprint({ ...ANCHORS, canvasCm: { w: 12, h: 10 }, elements: elements() })).not.toBe(base);
    const drifted = elements();
    drifted[0] = { ...drifted[0]!, boxPx: { x: 12, y: 8, w: 70, h: 66 } };
    expect(segmentLedgerFingerprint({ ...ANCHORS, elements: drifted })).not.toBe(base);
    expect(segmentLedgerFingerprint({ ...ANCHORS, elements: elements().slice(0, 1) })).not.toBe(base);
  });

  it('元素对象键序漂移（工件读回 vs 直注）→ fp 不变', () => {
    const base = segmentLedgerFingerprint({ ...ANCHORS, elements: elements() });
    const reordered = elements().map((e) => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(e).sort().reverse()) out[key] = (e as unknown as Record<string, unknown>)[key];
      return out as unknown as SceneElement;
    });
    expect(segmentLedgerFingerprint({ ...ANCHORS, elements: reordered })).toBe(base);
  });
});

// ---------------------------------------------------------------- [3] reqHash 投影

describe('segment-ledger reqHash 投影（R1-P0-1 剔 taskId）', () => {
  it('taskId 变 → hash 不变；prompt/iteration/调谐字段变 → hash 变', () => {
    const base = segmentRequestHash(segReq());
    expect(segmentRequestHash(segReq({ taskId: 'task-followup-new' }))).toBe(base);
    expect(segmentRequestHash(segReq({ text: 'ribbon as a whole' }))).not.toBe(base);
    expect(segmentRequestHash(segReq({ iteration: 1 }))).not.toBe(base);
    expect(segmentRequestHash(segReq({ confThreshold: 0.5 }))).not.toBe(base);
    expect(segmentRequestHash(segReq({ maskMaxSide: 1024 }))).not.toBe(base);
  });

  it('kind 变 → hash 变（segment vs analyze 同提示不同账目）', () => {
    const seg = segmentRequestHash(segReq());
    const ana = segmentRequestHash(
      makeAnalyzeRequest({
        taskId: 'task-a',
        imageBlobRef: ANCHORS.imageBlobRef,
        imagePx: ANCHORS.imagePx,
        canvasCm: ANCHORS.canvasCm,
        prompt: { kind: 'text', text: 'bouquet as a whole' },
        iteration: 0,
      }),
    );
    expect(seg).not.toBe(ana);
  });
});

// ---------------------------------------------------------------- [4] append/load 往返

describe('segment-ledger append/load 往返', () => {
  it('segment/analyze 双行往返+header 首行审计+内存 Map 即时命中', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const maskRef = s.blobs.put(new Uint8Array([1, 0, 1, 1])).hash;
      const ledger = ledgerOf(s);
      const segHash = segmentRequestHash(segReq());
      expect(ledger.get(segHash)).toBeUndefined();
      ledger.append({ v: 1, kind: 'segment', reqHash: segHash, maskBlobRef: maskRef, score: 0.8, model: 'sam3-mock', ts: FIXED_NOW() });
      // append 后内存 Map 即时命中（同文请求不重复真跑——tasks 1.1）
      expect(ledger.get(segHash)).toMatchObject({ kind: 'segment', maskBlobRef: maskRef, score: 0.8 });
      expect(ledger.segmentCount).toBe(1);
      const anaHash = segmentRequestHash(
        makeAnalyzeRequest({
          taskId: 'task-a',
          imageBlobRef: ANCHORS.imageBlobRef,
          imagePx: ANCHORS.imagePx,
          canvasCm: ANCHORS.canvasCm,
          prompt: { kind: 'text', text: 'redescribe' },
          iteration: 1,
        }),
      );
      ledger.append({ v: 1, kind: 'analyze', reqHash: anaHash, elements: elements(), ts: FIXED_NOW() });
      expect(ledger.segmentCount).toBe(1); // analyze 不计段
      // 新实例（重启模拟）重载文件
      const reloaded = ledgerOf(s);
      expect(reloaded.get(segHash)).toMatchObject({ kind: 'segment', maskBlobRef: maskRef, score: 0.8, model: 'sam3-mock' });
      expect(reloaded.get(anaHash)).toMatchObject({ kind: 'analyze', elements: elements() });
      // header 首行审计
      const fp = segmentLedgerFingerprint({ ...ANCHORS, elements: elements() });
      const firstLine = JSON.parse(readFileSync(ledgerPath(s, fp), 'utf8').split('\n')[0]!) as Record<string, unknown>;
      expect(firstLine).toMatchObject({ v: 1, fp, taskId0: 'task-a', createdAt: FIXED_NOW() });
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [5] 容错

describe('segment-ledger 容错与首行制', () => {
  it('坏尾行（崩溃半行）/结构不符行跳过', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const maskRef = s.blobs.put(new Uint8Array([1, 1])).hash;
      const ledger = ledgerOf(s);
      const hash1 = segmentRequestHash(segReq());
      ledger.append({ v: 1, kind: 'segment', reqHash: hash1, maskBlobRef: maskRef, ts: FIXED_NOW() });
      // 追加坏尾行（无换行的半行 JSON——崩溃形态）+一行结构不符（v=99 未来 schema）
      const fp = ledger.fingerprint;
      writeFileSync(ledgerPath(s, fp), '{"v":1,"kind":"segment","reqHash":"partial', { flag: 'a' });
      writeFileSync(ledgerPath(s, fp), '\n{"v":99,"kind":"segment","reqHash":"' + '9'.repeat(64) + '","maskBlobRef":"' + '8'.repeat(64) + '"}\n', { flag: 'a' });
      const reloaded = ledgerOf(s, fp);
      expect(reloaded.get(hash1)).toBeDefined();
      expect(reloaded.get('9'.repeat(64))).toBeUndefined();
      expect(parseSegmentLedgerLine('{"v":1,"kind":"segment","reqHash":"bad","maskBlobRef":"' + '8'.repeat(64) + '"}')).toBeNull();
    } finally {
      s.dispose();
    }
  });

  it('坏 blobRef 行（掩码 blob 不在库=已释放）跳过——回放 miss 自愈', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const hash = segmentRequestHash(segReq());
      const deadRef = 'd'.repeat(64); // 从未 put——无 active 行
      const ledger = ledgerOf(s);
      ledger.append({ v: 1, kind: 'segment', reqHash: hash, maskBlobRef: deadRef, ts: FIXED_NOW() });
      expect(ledger.get(hash)).toBeDefined(); // append 侧不查（写时 blob 必在——桥刚落）
      const reloaded = ledgerOf(s, ledger.fingerprint); // load 侧存在性复查
      expect(reloaded.get(hash)).toBeUndefined();
    } finally {
      s.dispose();
    }
  });

  it('同 reqHash 多行取首行（驱逐竞态下双写——回放确定）', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const maskA = s.blobs.put(new Uint8Array([1])).hash;
      const maskB = s.blobs.put(new Uint8Array([1, 1])).hash;
      const hash = segmentRequestHash(segReq());
      const ledger = ledgerOf(s);
      ledger.append({ v: 1, kind: 'segment', reqHash: hash, maskBlobRef: maskA, score: 0.8, ts: FIXED_NOW() });
      // 并发写同 hash（模拟：直接追加第二行——首写后 Map 已命中，正常流不会再 append）
      writeFileSync(
        ledgerPath(s, ledger.fingerprint),
        `${JSON.stringify({ v: 1, kind: 'segment', reqHash: hash, maskBlobRef: maskB, score: 0.9, ts: FIXED_NOW() })}\n`,
        { flag: 'a' },
      );
      const reloaded = ledgerOf(s, ledger.fingerprint);
      expect(reloaded.get(hash)).toMatchObject({ maskBlobRef: maskA, score: 0.8 }); // 首行制
      expect(reloaded.segmentCount).toBe(1);
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [6] GC

describe('segment-ledger GC（mtime 清扫）', () => {
  it('超龄删除+新鲜保留（注入 now——确定性）', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const dir = path.join(s.config.dataRoot, SEGMENT_LEDGERS_DIRNAME);
      mkdirSync(dir, { recursive: true });
      const oldFile = path.join(dir, 'old.jsonl');
      const freshFile = path.join(dir, 'fresh.jsonl');
      writeFileSync(oldFile, '{}\n');
      writeFileSync(freshFile, '{}\n');
      const now = Date.now();
      utimesSync(oldFile, new Date(now - 20 * 24 * 3600 * 1000), new Date(now - 20 * 24 * 3600 * 1000)); // 20d 前
      utimesSync(freshFile, new Date(now - 2 * 24 * 3600 * 1000), new Date(now - 2 * 24 * 3600 * 1000)); // 2d 前
      const removed = gcSegmentLedgers(s.config.dataRoot, { maxAgeDays: 14, now: () => now });
      expect(removed).toBe(1);
      const reRemoved = gcSegmentLedgers(s.config.dataRoot, { maxAgeDays: 14, now: () => now }); // 幂等
      expect(reRemoved).toBe(0);
    } finally {
      s.dispose();
    }
  });

  it('env 天数解析（≥1 有限数采用；非数字/越界回缺省 14）', () => {
    expect(segmentLedgerGcDays({ SEGMENT_LEDGER_GC_DAYS: '30' })).toBe(30);
    expect(segmentLedgerGcDays({ SEGMENT_LEDGER_GC_DAYS: '0.5' })).toBe(14);
    expect(segmentLedgerGcDays({ SEGMENT_LEDGER_GC_DAYS: 'abc' })).toBe(14);
    expect(segmentLedgerGcDays({})).toBe(14);
  });
});
