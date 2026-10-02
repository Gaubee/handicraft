/**
 * 段循环断点账本（add-segment-checkpoint-resume T1/T4——291 段超窗根治的回放索引）。
 * 原始需求 2026-10-02（Owner 挂账：291 段全分解 3.8h 纯串行 SAM，三重杀窗——看门狗
 * 静默杀/MCP 超时切断/重试驱逐从零——任何 >20min 逐段分解的图永远不可能完成）。
 * 续跑地基：segment-loop 是确定性状态机（同 deps 脚本 ⇒ 同请求序同产物）+桥层
 * materialize 已把每个成功响应掩码物化成任务域 blob——本模块补「请求→响应」的
 * 可回放索引：`DATA_ROOT/segment-ledgers/<fp16>.jsonl` 逐行 append（frames.jsonl
 * 同款纪律），行=segment（maskBlobRef 复用桥已落 blob）/analyze（elements 内嵌）。
 * 正交意图：
 *   [1] 指纹：sha256(canonicalJson({imageBlobRef,imagePx,canvasCm,elements})) 前 16
 *       hex——「同分解输入归同一账本」的键；不含 taskId/判据参数（条目级分叉由
 *       reqHash 投影兜底，参数漂移自然 miss 走真桥无错配）。
 *   [2] reqHash 投影（R1-P0-1）：哈希输入白名单剔 taskId（SamSegmentRequest 锚点
 *       含 taskId——不剔则 followup/steer 新 task 条目全 miss，跨任务续跑断裂）。
 *   [3] 账本读写：load（坏尾行跳过/坏 blobRef 行跳过自愈/同 hash 首行制）+ append
 *       （header 首行审计+内存 Map 同步更新——同文请求即时命中不重复真跑）。
 *   [4] GC：boot 时 mtime 清扫（SEGMENT_LEDGER_GC_DAYS 缺省 14；不做 blob 存在性
 *       回查——读放大不值，缺失自愈）。
 * 单写者假设（R1-P2-4）：appendFileSync 跨进程无锁，本设计假设单 daemon 实例独占
 * DATA_ROOT（现状成立）；验收用独立实例须配独立 DATA_ROOT。
 * 纯函数与 IO 分离：指纹/投影/GC 判定可单测；SegmentLedger 类持文件+内存双面。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { SceneElementSchema, type SceneElement } from '@handicraft/contracts';
import type { BlobStore } from '../../db/blobs.js';
import type { SamBridgeRequest } from './sam-bridge.js';

// ---------------------------------------------------------------- 冻结常量

/** 账本根目录名（DATA_ROOT 下）。 */
export const SEGMENT_LEDGERS_DIRNAME = 'segment-ledgers';

/** 指纹截断长度（hex——sha256 前 16 字符，目录名空间 2^64 足够）。 */
export const SEGMENT_LEDGER_FP_HEX = 16;

/** 账本 GC 天数缺省（design §2：14d）。 */
export const SEGMENT_LEDGER_GC_DAYS_DEFAULT = 14;

/**
 * env 覆盖读取（天单位——envTimeoutMs 同款纪律的放宽版；MCP_TOOL_CALL_TIMEOUT_MS
 * 先例）：≥1 的有限数才采用，否则回缺省。惰性读 env（脚本 import 后才置 env 的
 * 测试形态）。
 */
export function segmentLedgerGcDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SEGMENT_LEDGER_GC_DAYS);
  return Number.isFinite(raw) && raw >= 1 ? raw : SEGMENT_LEDGER_GC_DAYS_DEFAULT;
}

// ---------------------------------------------------------------- 规范化 JSON

/**
 * 规范化 JSON（键排序递归+undefined 键吸收）：确定性哈希的序列化基。undefined
 * 漂移被自然吸收（tuneSegmentRequest 仅在非 undefined 时展开键——「不发字段=服务端
 * 缺省」与「显式 undefined」哈希等价，正是要的语义）。数值/字符串原样（不归一化
 * 浮点——投影字段全为协议冻结值域）。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item === undefined) continue;
    out[key] = canonicalize(item);
  }
  return out;
}

// ---------------------------------------------------------------- 指纹（纯函数）

/** 指纹输入面（resolveElements 产物——工件读回或直注，均过 zod parse）。 */
export interface SegmentFingerprintInput {
  imageBlobRef: string;
  imagePx: { width: number; height: number };
  canvasCm: { w: number; h: number };
  elements: readonly SceneElement[];
}

/**
 * 循环内容指纹：sha256(canonicalJson({imageBlobRef,imagePx,canvasCm,elements}))
 * 前 16 hex。elements 键序由 canonicalJson 递归消化（工件读回/直注同指纹）。
 */
export function segmentLedgerFingerprint(input: SegmentFingerprintInput): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        imageBlobRef: input.imageBlobRef,
        imagePx: input.imagePx,
        canvasCm: input.canvasCm,
        elements: input.elements,
      }),
      'utf8',
    )
    .digest('hex')
    .slice(0, SEGMENT_LEDGER_FP_HEX);
}

// ---------------------------------------------------------------- reqHash 投影（纯函数）

/**
 * 请求哈希投影（R1-P0-1——跨任务命中依据）：哈希输入白名单
 * `{kind, imageBlobRef, imagePx, canvasCm, prompt, iteration, confThreshold?, maskMaxSide?}`
 * ——**剔 taskId**（调用方上下文非分解内容；followup/steer 落新 task 后条目才能
 * 条目级命中）。tuned 请求经 zod strict schema 过滤无杂键。
 * 已知微语义漂移留痕（R1-P2-6）：同轮两个元素 box+hint 完全相同 ⇒ 首轮请求同文
 * ⇒ 同 reqHash ⇒ 回放复用一响应（原本是两次独立 SAM 采样——省一次采样，可接受）。
 */
export function segmentRequestHash(request: SamBridgeRequest): string {
  const projected = {
    kind: request.kind,
    imageBlobRef: request.imageBlobRef,
    imagePx: request.imagePx,
    canvasCm: request.canvasCm,
    prompt: request.prompt,
    iteration: request.iteration,
    ...(request.kind === 'segment' && request.confThreshold !== undefined
      ? { confThreshold: request.confThreshold }
      : {}),
    ...(request.kind === 'segment' && request.maskMaxSide !== undefined
      ? { maskMaxSide: request.maskMaxSide }
      : {}),
  };
  return createHash('sha256').update(canonicalJson(projected), 'utf8').digest('hex');
}

// ---------------------------------------------------------------- 行模型

/** 账本行判别联合（v=1；schema 演进按行跳过——加载按行容错）。 */
export interface SegmentLedgerSegmentRow {
  v: 1;
  kind: 'segment';
  /** 投影哈希（64 hex——回放键）。 */
  reqHash: string;
  /** 桥 materialize 已落掩码 blob（内容寻址——回放经 BlobStore 读回）。 */
  maskBlobRef: string;
  score?: number;
  model?: string;
  ts: string;
}

export interface SegmentLedgerAnalyzeRow {
  v: 1;
  kind: 'analyze';
  reqHash: string;
  /** VLM 复入响应内嵌（hint 精化回放——vlmReentry 分叉确定性依据）。 */
  elements: SceneElement[];
  ts: string;
}

export type SegmentLedgerRow = SegmentLedgerSegmentRow | SegmentLedgerAnalyzeRow;

/** 首行 header（审计面——加载不依赖，taskId0=首个实跑任务）。 */
export interface SegmentLedgerHeader {
  v: 1;
  fp: string;
  taskId0: string;
  createdAt: string;
}

// ---------------------------------------------------------------- 行解析（纯函数）

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * 单行解析（纯函数）：坏行（JSON 损坏/结构不符/v≠1/reqHash 非法）返回 null——
 * 崩溃半行/未来 schema 行按行跳过（设计 §2 容错与确定性）。segment 行的
 * maskBlobRef 合法性在 load 侧做 blob 存在性复查（坏 blobRef 行跳过自愈）。
 */
export function parseSegmentLedgerLine(line: string): SegmentLedgerRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (row.v !== 1 || (row.kind !== 'segment' && row.kind !== 'analyze')) return null;
  if (typeof row.reqHash !== 'string' || !HEX64.test(row.reqHash)) return null;
  if (typeof row.ts !== 'string' || row.ts.length === 0) return null;
  if (row.kind === 'segment') {
    if (typeof row.maskBlobRef !== 'string' || !HEX64.test(row.maskBlobRef)) return null;
    const out: SegmentLedgerSegmentRow = {
      v: 1,
      kind: 'segment',
      reqHash: row.reqHash,
      maskBlobRef: row.maskBlobRef,
      ts: row.ts,
    };
    if (typeof row.score === 'number') out.score = row.score;
    if (typeof row.model === 'string') out.model = row.model;
    return out;
  }
  if (!Array.isArray(row.elements)) return null;
  // 不信任注入面（ensureCanvasMask 同款纪律）：磁盘回读的 elements 过 schema 校验
  // ——损坏行按行跳过（回放 miss 自愈），不把畸形结构直喂循环。
  const elements = SceneElementSchema.array().safeParse(row.elements);
  if (!elements.success) return null;
  return { v: 1, kind: 'analyze', reqHash: row.reqHash, elements: elements.data, ts: row.ts };
}

// ---------------------------------------------------------------- 账本本体（IO 面）

export interface SegmentLedgerDeps {
  dataRoot: string;
  blobs: BlobStore;
  /** 行 ts/header createdAt 时钟（确定性测试注入固定值；缺省真时钟）。 */
  now?: () => string;
}

/**
 * 单账本读写面（fp 键控的 jsonl 文件+内存 Map 双面）：
 * - load：读回全部行构建 Map——坏行跳过、segment 行 blob 缺失跳过（自愈=重请求）、
 *   **同 reqHash 多行取首行**（驱逐竞态下新旧循环并发写同 hash——内容同为合法
 *   响应，首行制保证回放确定）；
 * - append：appendFileSync 逐行（header 首行一次）+内存 Map 同步更新（首写制——
 *   同文请求即时命中，不重复真跑）。
 * 生命周期：进程内按 fp 复用单实例（executor 持缓存）；新 executor=重载文件
 * （重启模拟）。线程模型：单 daemon 单写者（模块头注假设）。
 */
export class SegmentLedger {
  private readonly entries = new Map<string, SegmentLedgerRow>();
  private readonly filePath: string;
  private readonly deps: SegmentLedgerDeps;
  private readonly fp: string;
  private headerWritten = false;
  /** header 首行审计字段（首个实跑任务——账本新起时落 header 用）。 */
  private headerTaskId0 = '';

  private constructor(deps: SegmentLedgerDeps, fp: string) {
    this.deps = deps;
    this.fp = fp;
    this.filePath = path.join(deps.dataRoot, SEGMENT_LEDGERS_DIRNAME, `${fp}.jsonl`);
  }

  /** 加载既有账本（文件缺失=空账本新起）。 */
  static load(deps: SegmentLedgerDeps, fp: string, taskId0: string): SegmentLedger {
    const ledger = new SegmentLedger(deps, fp);
    ledger.headerTaskId0 = taskId0;
    if (existsSync(ledger.filePath)) {
      const text = readFileSync(ledger.filePath, 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue;
        const row = parseSegmentLedgerLine(line);
        if (row === null) continue; // 坏尾行/未来 schema——按行跳过
        if (row.kind === 'segment' && deps.blobs.rowOf(row.maskBlobRef) === null) {
          continue; // 掩码 blob 已释放（原会话清理）——死条目跳过，回放 miss 自愈重跑
        }
        if (!ledger.entries.has(row.reqHash)) ledger.entries.set(row.reqHash, row); // 首行制
      }
      ledger.headerWritten = true; // 既有文件 header 已在（坏首行 header 也无妨——审计面）
    }
    return ledger;
  }

  /** 账本指纹（checkpointed 结果面 ledgerFp）。 */
  get fingerprint(): string {
    return this.fp;
  }

  /** 条目查询（回放面——未命中 undefined）。 */
  get(reqHash: string): SegmentLedgerRow | undefined {
    return this.entries.get(reqHash);
  }

  /** 死条目摘除（回放读 blob 失败时的内存面自愈——文件行保留，重启 load 复查兜底）。 */
  drop(reqHash: string): void {
    this.entries.delete(reqHash);
  }

  /** 已银行 segment 行数（checkpointed 结果面 bankedSegments）。 */
  get segmentCount(): number {
    let n = 0;
    for (const row of this.entries.values()) if (row.kind === 'segment') n++;
    return n;
  }

  /** 追记账本行（appendFileSync+内存 Map 同步；调用方保证先查 get 未命中）。 */
  append(row: SegmentLedgerRow): void {
    if (!this.headerWritten) {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const header: SegmentLedgerHeader = {
        v: 1,
        fp: this.fp,
        taskId0: this.headerTaskId0,
        createdAt: this.deps.now?.() ?? new Date().toISOString(),
      };
      appendFileSync(this.filePath, `${JSON.stringify(header)}\n`, 'utf8');
      this.headerWritten = true;
    }
    appendFileSync(this.filePath, `${JSON.stringify(row)}\n`, 'utf8');
    if (!this.entries.has(row.reqHash)) this.entries.set(row.reqHash, row);
  }
}

// ---------------------------------------------------------------- GC（IO 面，判定纯）

/**
 * 账本 GC：清扫 `DATA_ROOT/segment-ledgers/` 下 mtime 超龄的账本文件（boot 时
 * fire-and-forget——失败由调用方吞掉不阻塞）。不做 blob 存在性回查（读放大不值，
 * 缺失自愈）；会话三段清不级联删账本（blob 释放后行自然成死条目被 load 跳过）。
 * now 注入面=测试确定性；返回删除数（日志/断言面）。
 */
export function gcSegmentLedgers(
  dataRoot: string,
  options: { maxAgeDays?: number; now?: () => number } = {},
): number {
  const dir = path.join(dataRoot, SEGMENT_LEDGERS_DIRNAME);
  if (!existsSync(dir)) return 0;
  const maxAgeDays = options.maxAgeDays ?? segmentLedgerGcDays();
  const now = options.now?.() ?? Date.now();
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        rmSync(full);
        removed++;
      }
    } catch {
      // 单文件 stat/rm 竞态（并发删除等）——跳过该文件，不阻塞清扫
    }
  }
  return removed;
}
