/**
 * SshSamTransport 真实现假体单测（add-subject-sam-pipeline P2.6）。
 * 真连不能进 CI（macmini 内部拓扑）——本文件以**注入 sshBinary 假体**走与生产完全
 * 同一的 spawn 路径：假体=可执行 shell 脚本（忽略 ssh 旗标/目标/远端命令参数）→
 * exec 本地 node 假服务（stdin/stdout 行协议直通，P2.1 PROTOCOL 形状）。
 * 覆盖面：version 握手+meta.model 标签 / segment 往返+mask 直映射 / 会话复用（一次
 * spawn 多请求）/ 零检出→全零 inline mask / 线上 TIMEOUT→typed timeout / analyze
 * UNSUPPORTED→typed unimplemented（scene.analyze 降级路由信号）/ 客户端取消=弃置
 * 不杀会话+迟到响应按 id 丢弃（串扰防线）/ 会话死亡→全部 typed transport+重生 /
 * spawn 失败 typed transport / finish() 优雅关闭（shutdown 行→退出码 0）+幂等。
 * 零常驻纪律：每用例 finally finish()；假服务随 stdin EOF/kill 退出（afterAll 兜底
 * rmSync 数据目录）。
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeInlineMask } from '@handicraft/contracts';
import {
  SamBridgeError,
  SshSamTransport,
  makeAnalyzeRequest,
  makeSegmentRequest,
  type SamBridgeRequest,
  type SamTransportCall,
} from '../src/kernel/vision/sam-bridge.js';

// ---------------------------------------------------------------- 假体装配

/** 假服务行为协议（prompt.text 携带指令——传输只透传文本，假体侧解译）。 */
const FAKE_SERVICE = String.raw`
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const respond = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch {
    respond({ id: null, ok: false, error: { code: 'PARSE_ERROR', message: 'bad json' } });
    return;
  }
  const id = req.id;
  const method = req.method;
  const params = req.params ?? {};
  const text = String(params.prompt?.text ?? '');
  if (method === 'version') {
    respond({ id, ok: true, result: { service: 'fake', protocol: '1', mlxSam3: '0.0.0-fake', model: 'fake-sam3', mode: 'direct' } });
    return;
  }
  if (method === 'shutdown') {
    respond({ id, ok: true, result: { bye: true, pid: process.pid } });
    process.exit(0);
    return;
  }
  if (method === 'analyze') {
    respond({ id, ok: false, error: { code: 'UNSUPPORTED', message: 'fake 服务无 VLM 面', details: { capability: 'vlm-analyze' } } });
    return;
  }
  if (method === 'segment') {
    if (params.prompt?.points !== undefined) {
      respond({ id, ok: false, error: { code: 'UNSUPPORTED', message: '点提示不支持', details: { capability: 'points-prompt' } } });
      return;
    }
    if (text.startsWith('crash')) { process.exit(7); return; }
    if (text.startsWith('sleep')) {
      const ms = Number(text.split(':')[1] ?? '500');
      setTimeout(() => {
        respond({ id, ok: false, error: { code: 'TIMEOUT', message: 'fake 软超时', details: { timeoutSec: params.timeoutSec } } });
      }, ms);
      return;
    }
    if (text === 'empty') {
      // P2.1 真身形状：零检出回 score:null/mask:null（count=0 非错误）——live 实测 2026-09-25
      respond({ id, ok: true, result: { width: 8, height: 8, count: 0, detections: [], mask: null, score: null, maskPx: 0 } });
      return;
    }
    const striped = Buffer.from(new Uint8Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]));
    const mask = { w: 4, h: 4, dataBase64: striped.toString('base64') };
    respond({
      id,
      ok: true,
      result: {
        width: 8,
        height: 8,
        count: 1,
        detections: [{ mask, maskPx: 4, score: 0.91, boxPx: [1, 1, 4, 4], label: 'x' }],
        mask,
        score: 0.91,
        maskPx: 4,
        echoPrompt: params.prompt,
        // P2.1 真身形状：overlay 是 {mime, dataBase64} 对象（非裸 base64 串——live 实测 2026-09-25）
        ...(params.overlay
          ? { overlay: { mime: 'image/jpeg', dataBase64: Buffer.from('fake-jpeg-bytes').toString('base64') } }
          : {}),
      },
    });
    return;
  }
  respond({ id, ok: false, error: { code: 'METHOD_NOT_FOUND', message: String(method) } });
});
`;

/** 假体 ssh：忽略全部参数（旗标/目标/远端命令），直通本地假服务（__占位__ beforeAll 注入；首行必须 shebang）。 */
const FAKE_SSH = [
  '#!/bin/sh',
  '# P2.6 测试假体：参数全忽略，等价于「直达一条已认证的 ssh 会话」',
  'exec "__NODE_BIN__" "__SERVICE_JS__"',
  '',
].join('\n');

let fakeDir: string;
let nodeBin: string;

beforeAll(() => {
  fakeDir = mkdtempSync(path.join(tmpdir(), 'sam-ssh-fake-'));
  nodeBin = process.execPath;
  const serviceJs = path.join(fakeDir, 'fake-sam3-service.mjs');
  writeFileSync(serviceJs, FAKE_SERVICE, 'utf8');
  const sshSh = path.join(fakeDir, 'fake-ssh.sh');
  writeFileSync(
    sshSh,
    FAKE_SSH.replaceAll('__NODE_BIN__', nodeBin).replaceAll('__SERVICE_JS__', serviceJs),
    'utf8',
  );
  chmodSync(sshSh, 0o755);
});

afterAll(() => {
  rmSync(fakeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fixture

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03, 0x04]); // 传输不解码——任意字节即可

function transport(extra: Record<string, unknown> = {}): SshSamTransport {
  return new SshSamTransport({
    host: 'ignored-by-fake',
    remoteCommand: 'python3 sam3_service.py',
    sshBinary: path.join(fakeDir, 'fake-ssh.sh'),
    connectTimeoutMs: 5_000,
    ...extra,
  });
}

function call(request: SamBridgeRequest, signal?: AbortSignal): SamTransportCall {
  return { request, imageBytes: PNG_BYTES, ...(signal !== undefined ? { signal } : {}) };
}

function segReq(text: string, iteration = 0): SamBridgeRequest {
  return makeSegmentRequest({
    taskId: 'f'.repeat(16),
    imageBlobRef: 'a'.repeat(64),
    imagePx: { width: 8, height: 8 },
    canvasCm: { w: 8, h: 8 },
    prompt: { kind: 'text', text },
    iteration,
  });
}

async function captureError(p: Promise<unknown>): Promise<SamBridgeError> {
  const error = await p.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SamBridgeError);
  return error as SamBridgeError;
}

// ---------------------------------------------------------------- 测试

describe('SshSamTransport 真实现（假体 ssh 直通）', () => {
  it('version 握手+segment 往返：mask 直映射+meta.model=握手标签+iteration 回显', async () => {
    const t = transport();
    try {
      const response = await t.send(call(segReq('person')));
      expect(response.kind).toBe('segment');
      if (response.kind !== 'segment') return;
      expect(response.mask.kind).toBe('inline');
      if (response.mask.kind !== 'inline') return;
      const { w, h, bits } = decodeInlineMask(response.mask);
      expect([w, h]).toEqual([4, 4]);
      expect(Array.from(bits)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
      expect(response.score).toBeCloseTo(0.91);
      expect(response.meta.model).toBe('fake-sam3@0.0.0-fake');
      expect(response.meta.iteration).toBe(0);
      expect(response.meta.durationMs).toBeGreaterThanOrEqual(0);
      expect(response.overlay).toBeUndefined(); // 未开 requestOverlay
      expect(t.spawnCount).toBe(1); // lazy 起——首 send 才 spawn
    } finally {
      await t.finish();
    }
  });

  it('会话复用：两次 send 一次 spawn（ssh 会话=常驻服务）', async () => {
    const t = transport();
    try {
      await t.send(call(segReq('a')));
      await t.send(call(segReq('b', 1)));
      expect(t.spawnCount).toBe(1);
      expect(t.sessionAlive).toBe(true);
    } finally {
      await t.finish();
    }
  });

  it('geometric 带 box：线上 prompt=box-only（points 被 box 包络）+overlay 透传', async () => {
    const t = transport({ requestOverlay: true });
    try {
      const request = makeSegmentRequest({
        taskId: 'f'.repeat(16),
        imageBlobRef: 'a'.repeat(64),
        imagePx: { width: 8, height: 8 },
        canvasCm: { w: 8, h: 8 },
        prompt: {
          kind: 'geometric',
          points: [{ x: 4, y: 4, label: 'include' }],
          box: { x: 1, y: 1, w: 6, h: 5 },
        },
        iteration: 2,
      });
      const response = await t.send(call(request));
      expect(response.kind).toBe('segment');
      if (response.kind !== 'segment') return;
      expect(response.overlay).toEqual({ mime: 'image/jpeg', dataBase64: expect.any(String) });
      expect(response.meta.iteration).toBe(2);
    } finally {
      await t.finish();
    }
  });

  it('geometric 仅 points：线上收 UNSUPPORTED→typed unimplemented（不重试）', async () => {
    const t = transport();
    try {
      const request = makeSegmentRequest({
        taskId: 'f'.repeat(16),
        imageBlobRef: 'a'.repeat(64),
        imagePx: { width: 8, height: 8 },
        canvasCm: { w: 8, h: 8 },
        prompt: { kind: 'geometric', points: [{ x: 4, y: 4, label: 'include' }] },
        iteration: 0,
      });
      const error = await captureError(t.send(call(request)));
      expect(error.kind).toBe('unimplemented');
      expect(error.message).toMatch(/点提示不支持|UNSUPPORTED/);
    } finally {
      await t.finish();
    }
  });

  it('零检出（count=0/mask=null）：合成全零 inline mask（非错误——循环侧 no-instance）', async () => {
    const t = transport();
    try {
      const response = await t.send(call(segReq('empty')));
      expect(response.kind).toBe('segment');
      if (response.kind !== 'segment') return;
      expect(response.mask.kind).toBe('inline');
      if (response.mask.kind !== 'inline') return;
      const { w, h, bits } = decodeInlineMask(response.mask);
      expect([w, h]).toEqual([8, 8]);
      expect(bits.every((b) => b === 0)).toBe(true);
      expect(response.score).toBeUndefined();
    } finally {
      await t.finish();
    }
  });

  it('线上 TIMEOUT 错误行→typed timeout（软界由远端自收口，会话存活）', async () => {
    const t = transport();
    try {
      const error = await captureError(t.send(call(segReq('sleep:120'))));
      expect(error.kind).toBe('timeout');
      expect(error.message).toMatch(/TIMEOUT|软超时/);
      expect(t.sessionAlive).toBe(true);
    } finally {
      await t.finish();
    }
  });

  it('analyze→UNSUPPORTED→typed unimplemented（scene.analyze 降 LLM 路由信号）', async () => {
    const t = transport();
    try {
      const request = makeAnalyzeRequest({
        taskId: 'f'.repeat(16),
        imageBlobRef: 'a'.repeat(64),
        imagePx: { width: 8, height: 8 },
        canvasCm: { w: 8, h: 8 },
        prompt: { kind: 'text', text: 'describe the scene' },
      });
      const error = await captureError(t.send(call(request)));
      expect(error.kind).toBe('unimplemented');
      expect(error.message).toMatch(/VLM|不支持/);
    } finally {
      await t.finish();
    }
  });

  it('客户端取消：send 即刻 rejected cancelled，会话保活，迟到响应按 id 丢弃', async () => {
    const t = transport();
    try {
      const controller = new AbortController();
      const sent = t.send(call(segReq('sleep:600'), controller.signal));
      const abortAt = Date.now();
      setTimeout(() => controller.abort(), 60);
      const error = await captureError(sent);
      expect(error.kind).toBe('cancelled');
      expect(Date.now() - abortAt).toBeLessThan(1_000); // 即刻落定（不等 600ms 迟到响应）
      expect(t.sessionAlive).toBe(true); // 取消≠杀会话——模型常驻不受影响
      // 后续请求按 id 对齐照常往返（若迟到响应串扰，此请求会拿到错误 envelope）
      const followUp = await t.send(call(segReq('next')));
      expect(followUp.kind).toBe('segment');
      // 迟到响应（~600ms）到达后被 id 键控丢弃——等待它落地再验证零悬挂
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(t.sessionAlive).toBe(true);
    } finally {
      await t.finish();
    }
  });

  it('会话死亡：pending 全部 typed transport；下次 send 重生（自愈）', async () => {
    const t = transport();
    try {
      const error = await captureError(t.send(call(segReq('crash'))));
      expect(error.kind).toBe('transport');
      expect(t.sessionAlive).toBe(false);
      expect(t.spawnCount).toBe(1);
      const revived = await t.send(call(segReq('again'))); // 重 spawn+重握手
      expect(revived.kind).toBe('segment');
      expect(t.spawnCount).toBe(2);
      expect(t.sessionAlive).toBe(true);
    } finally {
      await t.finish();
    }
  });

  it('spawn 失败（sshBinary 不存在）：typed transport（ENOENT 呈现）', async () => {
    const t = transport({ sshBinary: path.join(fakeDir, 'no-such-ssh-bin') });
    const error = await captureError(t.send(call(segReq('person'))));
    expect(error.kind).toBe('transport');
    expect(error.message).toMatch(/spawn|ENOENT/);
    await t.finish(); // 无会话——幂等无操作
  });

  it('握手超时：version 不回→typed transport+会话收口', async () => {
    // 假体替换为「吞掉首请求不回 version」的哑进程（cat 复制 stdin 到 stdout 无 JSON 帧）
    const dumbSh = path.join(fakeDir, 'dumb-ssh.sh');
    writeFileSync(dumbSh, '#!/bin/sh\nexec /bin/cat\n', 'utf8');
    chmodSync(dumbSh, 0o755);
    const t = transport({ sshBinary: dumbSh, connectTimeoutMs: 400 });
    try {
      const error = await captureError(t.send(call(segReq('person'))));
      expect(error.kind).toBe('transport');
      expect(error.message).toMatch(/握手超时|version/);
      expect(t.sessionAlive).toBe(false);
    } finally {
      await t.finish();
    }
  });

  it('finish()：shutdown 行优雅退出（假服务回 bye 后 exit 0）+幂等', async () => {
    const t = transport();
    await t.send(call(segReq('person')));
    expect(t.sessionAlive).toBe(true);
    await t.finish();
    expect(t.sessionAlive).toBe(false);
    expect(t.spawnCount).toBe(1); // finish 不重生
    await t.finish(); // 幂等
  });

  it('与桥装配：SamBridge+真 SshSamTransport 全链（请求→线上→物化→留存）', async () => {
    // 直接以假体传输跑一次桥 run——证明真实现满足 SamTransport 契约（桥侧无需 mock）
    const { createServices } = await import('./helpers.js');
    const s = createServices();
    const t = transport();
    try {
      const { SamBridge } = await import('../src/kernel/vision/sam-bridge.js');
      const { createJobTask } = await import('../src/db/jobs.js');
      const { encodePng } = await import('../src/png/codec.js');
      const taskId = createJobTask(s.db, {
        ownerId: s.anonymous.id,
        paramsJson: JSON.stringify({ kind: 'ssh-transport-test', params: {} }),
      }).id;
      const rgba = new Uint8Array(8 * 8 * 4).fill(128);
      const imageRef = s.blobs.put(encodePng(8, 8, rgba)).hash;
      const bridge = new SamBridge(
        { db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot },
        { transport: t, timeoutMs: 5_000 },
      );
      const request = makeSegmentRequest({
        taskId,
        imageBlobRef: imageRef,
        imagePx: { width: 8, height: 8 },
        canvasCm: { w: 8, h: 8 },
        prompt: { kind: 'text', text: 'person' },
        iteration: 0,
      });
      const result = await bridge.run(request);
      expect(result.kind).toBe('segment');
      if (result.kind === 'segment') {
        expect(result.mask).toMatchObject({ kind: 'blob', w: 4, h: 4 });
        expect(result.meta.model).toBe('fake-sam3@0.0.0-fake');
        expect(result.retention.exchangeJson).toContain(taskId);
      }
    } finally {
      await t.finish();
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- 进程零残留自证

it('afterAll 前置自证：假体 node 进程零残留', () => {
  // 假服务随 stdin EOF/finish kill 退出——ps 面全量扫描（本文件专用名，勿匹配全局 node）
  const out = execSync('/bin/ps -axo command=', { encoding: 'utf8' });
  const leaked = out
    .split('\n')
    .filter((l) => l.includes('fake-sam3-service.mjs') || l.includes('fake-ssh.sh'));
  expect(leaked).toEqual([]);
});
