/**
 * SQLite 模式与迁移（design §2 DB 行：zhumo 六核心表复用 + 授权/operation/attempt 四表）。
 * 原始需求 2026-09-23（W1.2）：better-sqlite3 + user_version 迁移。
 * 表清单（十四表）：
 *   核心六：users / settings / blobs / resources / tasks / results
 *           （tasks 含 type ∈ {job,agent} 与 session_id；results=public_id 分享包）
 *   授权四：patch_history（批准撤销组 §3.6.7）/ grants（§3.6 一次性授权持久化）/
 *           approved_ops（持久 operation 状态机，proposalId 唯一幂等键）/
 *           attempts（attempt 账本：attemptId 主键、proposalId+attemptNo 唯一、
 *           retryRequestId 唯一——§3.6 R5/R6）
 *   会话四（W3.2 §6.5）：sessions（clearing 栅栏+cleared tombstone）/
 *           session_blob_refs（会话侧引用账本）/ result_blob_refs（分享包独立引用）/
 *           cleanup_outbox（跨介质清理待删清单——完整旧代物理路径）
 * 偏差说明：design 的 meta JSON——SQLite 无 JSON 存储类，按 TEXT 落库（JSON 字符串）。
 * blobs 为代际行模型（design §6.5 R4/R5）：row_gen=行主键 UUID 永不复用，
 * 物理路径 <sha256>.<rowGen>；同 sha256 可存在多代行（deleting 旧行阻止复活）。
 */

export interface Migration {
  readonly version: number;
  readonly up: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('admin', 'user', 'anonymous')),
  created_at    TEXT NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 代际行模型：row_gen=行主键 UUID（永不复用）；hash 上有索引供 active 行命中去重；
-- status: active | deleting（归零置 deleting 阻止复活——新引用命中 deleting 行=新建行新文件）
CREATE TABLE IF NOT EXISTS blobs (
  row_gen    TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  store_path TEXT NOT NULL,
  ref_count  INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deleting')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blobs_hash_active ON blobs(hash) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS resources (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id),
  parent_id    TEXT REFERENCES resources(id),
  name         TEXT NOT NULL,
  is_dir       INTEGER NOT NULL,
  content_hash TEXT,
  size         INTEGER NOT NULL DEFAULT 0,
  meta         TEXT,
  -- revision CAS 基础（§3.6.4：grant 绑定 baseRevision，apply 时漂移必拒）
  revision     INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_owner ON resources(owner_id);
CREATE INDEX IF NOT EXISTS idx_resources_parent ON resources(parent_id);

-- type ∈ {job, agent}（design §2：引擎/生成作业 vs agent 会话任务两族状态机）
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  resource_id TEXT REFERENCES resources(id),
  session_id  TEXT,
  type        TEXT NOT NULL DEFAULT 'job' CHECK(type IN ('job', 'agent')),
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK(status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  params      TEXT,
  result_id   TEXT REFERENCES results(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);

CREATE TABLE IF NOT EXISTS results (
  id          TEXT PRIMARY KEY,
  public_id   TEXT NOT NULL UNIQUE,
  task_id     TEXT REFERENCES tasks(id),
  owner_id    TEXT NOT NULL REFERENCES users(id),
  title       TEXT,
  bundle_path TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_owner ON results(owner_id);

-- 批准撤销组（§3.6.7 patch 族：整组逆序回退，回退也记 history）
CREATE TABLE IF NOT EXISTS patch_history (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id),
  resource_id   TEXT NOT NULL,
  patch_group   TEXT NOT NULL,
  proposal_id   TEXT NOT NULL,
  op_kind       TEXT NOT NULL CHECK(op_kind IN ('setDensity', 'recolor', 'setSpec')),
  target        TEXT NOT NULL,
  before_json   TEXT NOT NULL,
  after_json    TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patch_history_group ON patch_history(resource_id, patch_group);

-- 一次性授权持久化（§3.6.2-3：grantId/nonce 永不出服务端；消费即焚）
CREATE TABLE IF NOT EXISTS grants (
  id            TEXT PRIMARY KEY,
  proposal_id   TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  op_digest     TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id),
  resource_id   TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  expires_at    TEXT NOT NULL,
  consumed      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grants_proposal ON grants(proposal_id);

-- 持久 operation（§3.6.6：approved→claimed→running→succeeded/failed/unknown；
-- proposalId=唯一幂等键，先原子 claim 再执行；启动扫描非终态→unknown）
CREATE TABLE IF NOT EXISTS approved_ops (
  proposal_id TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id),
  tool        TEXT NOT NULL,
  op_digest   TEXT NOT NULL,
  resource_id TEXT,
  state       TEXT NOT NULL DEFAULT 'approved'
              CHECK(state IN ('approved', 'claimed', 'running', 'succeeded', 'failed', 'unknown')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approved_ops_state ON approved_ops(state);

-- attempt 账本（§3.6 R5/R6：attemptId 持久唯一 UUID 主键；proposalId+attemptNo
-- 唯一；retryRequestId 唯一（跨归属复用必拒）；idemKey/state/父 op 关联）
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id      TEXT PRIMARY KEY,
  proposal_id     TEXT NOT NULL,
  attempt_no      INTEGER NOT NULL,
  idem_key        TEXT NOT NULL,
  retry_request_id TEXT NOT NULL,
  state           TEXT NOT NULL
                  CHECK(state IN ('claimed', 'running', 'succeeded', 'failed', 'unknown')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(proposal_id, attempt_no),
  UNIQUE(retry_request_id)
);
CREATE INDEX IF NOT EXISTS idx_attempts_proposal ON attempts(proposal_id);
`,
  },
  {
    // P1-6：「同 op 仅一个 active attempt」——partial unique index（对齐 contracts
    // ATTEMPT_ACTIVE_UNIQUE_INDEX 声明）。终态不占位，重试可开新 active；并发两
    // claim 仅一个成功（DB 层仲裁）。
    version: 2,
    up: `
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_one_active
  ON attempts(proposal_id)
  WHERE state IN ('claimed', 'running');
`,
  },
  {
    // W3.2（design §6.5）：sessions 表（clearing 栅栏 + cleared tombstone）、
    // session_blob_refs（会话侧 blob 引用账本——clear 只撤这侧）、result_blob_refs
    // （分享包独立引用——与会话生命周期解耦）、cleanup_outbox（跨介质清理待删清单——
    // 持久化完整旧代物理路径）；results 增 TTL/revoke 双列（默认 7 天，.env 可调）。
    version: 3,
    up: `
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'clearing', 'cleared')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cleared_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

-- 会话侧 blob 引用账本：一行 = 一次引用事件（与 blobs.put 的 ref_count 增量一一对应；
-- clear 逐行 releaseRef——不聚合去重，防同 hash 双 put 的计数漂移；无唯一约束——
-- 同毫秒重复引用是合法事件流，靠 rowid 保序）
CREATE TABLE IF NOT EXISTS session_blob_refs (
  session_id TEXT NOT NULL,
  blob_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 分享包（result）侧 blob 引用账本：独立生命周期（TTL/revoke 到期释放，与会话 clear 无关）
CREATE TABLE IF NOT EXISTS result_blob_refs (
  result_id  TEXT NOT NULL REFERENCES results(id),
  blob_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (result_id, blob_hash)
);

-- 跨介质清理 outbox：kind=blob（代际文件 unlink，重验行状态）、dir（任务目录/bundle 目录
-- 递归删）、file（单文件）。path 持久化**完整绝对路径**（迟到重放也只删该路径）。
CREATE TABLE IF NOT EXISTS cleanup_outbox (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK(kind IN ('blob', 'file', 'dir')),
  path       TEXT NOT NULL,
  blob_row   TEXT,
  session_id TEXT,
  result_id  TEXT,
  state      TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'done', 'failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON cleanup_outbox(state);
CREATE INDEX IF NOT EXISTS idx_outbox_session ON cleanup_outbox(session_id);

ALTER TABLE results ADD COLUMN expires_at TEXT;
ALTER TABLE results ADD COLUMN revoked_at TEXT;
`,
  },
];
