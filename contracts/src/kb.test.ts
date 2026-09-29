/**
 * kb 契约测试（split-admin-portal 波 3——agent 读面/admin 管理面/修订历史的
 * 冻结签名逐字段断言）。与 admin.test.ts 同定位：schema 层只守形状与边界，
 * 存在性/权限类拒面归 daemon 集成测试（tests/kb-rpc.test.ts）。
 */
import { describe, expect, it } from 'vitest';
import {
  KbAdminListOutputSchema,
  KbEntryDeleteInputSchema,
  KbEntrySaveInputSchema,
  KbGetInputSchema,
  KbGetOutputSchema,
  KbGroupDeleteInputSchema,
  KbGroupSaveInputSchema,
  KbListOutputSchema,
  KbRestoreInputSchema,
  KbRestoreOutputSchema,
  KbRevisionGetInputSchema,
  KbRevisionGetOutputSchema,
  KbRevisionSchema,
  KbRevisionsOutputSchema,
} from './kb.js';

const fullGroups = {
  groups: [
    {
      name: '钻径与规格',
      note: 'SS 尺码与选用要点',
      entries: [{ key: 'SS 尺码表（SS6–SS34）', value: 'SS6=2.0 … SS34=7.1' }],
    },
  ],
};

describe('agent 读面（keys-only 扫描 + 单条全文）', () => {
  it('KbListOutput：组名+note+keys（不含 value）；缺字段/多余字段拒', () => {
    expect(
      KbListOutputSchema.parse({
        groups: [{ name: '钻径与规格', note: 'SS 尺码', keys: ['SS 尺码表（SS6–SS34）'] }],
      }),
    ).toEqual({ groups: [{ name: '钻径与规格', note: 'SS 尺码', keys: ['SS 尺码表（SS6–SS34）'] }] });
    // keys-only 冻结：组对象仅 name/note/keys 三字段（多余字段被剥——schema 非
    // strict，zhumo 同构；value 面只在 KbAdminListOutput）
    expect(
      Object.keys(
        KbListOutputSchema.parse({ groups: [{ name: 'g', note: '', keys: [], entries: [] }] }).groups[0]!,
      ).sort(),
    ).toEqual(['keys', 'name', 'note']);
    expect(KbListOutputSchema.safeParse({ groups: [{ name: 'g', note: '' }] }).success).toBe(false);
  });

  it('KbGet：group/key trim 边界（空/超长拒，中文放行）；输出 entry 三字段', () => {
    expect(KbGetInputSchema.parse({ group: '色系与编码', key: 'ΔE76 色容差三档（3/10/25）' })).toEqual({
      group: '色系与编码',
      key: 'ΔE76 色容差三档（3/10/25）',
    });
    expect(KbGetInputSchema.safeParse({ group: '  ', key: 'k' }).success).toBe(false);
    expect(KbGetInputSchema.safeParse({ group: 'g', key: 'x'.repeat(129) }).success).toBe(false);
    expect(KbGetInputSchema.safeParse({ group: 'g' }).success).toBe(false);
    const out = KbGetOutputSchema.parse({
      entry: { group: 'g', key: 'k', value: 'v' },
    });
    expect(Object.keys(out.entry).sort()).toEqual(['group', 'key', 'value']);
  });
});

describe('admin 管理面（upsert/delete/rename 字段形态）', () => {
  it('KbAdminListOutput：全量含 entries+value（后台编辑器数据源）', () => {
    expect(KbAdminListOutputSchema.parse(fullGroups)).toEqual(fullGroups);
    expect(
      KbAdminListOutputSchema.safeParse({ groups: [{ name: 'g', note: '', keys: [] }] }).success,
    ).toBe(false);
  });

  it('KbGroupSave：note≤500 可选 + newName 改名通道；分组名 1–64', () => {
    expect(KbGroupSaveInputSchema.parse({ name: '工艺规则', note: '可读性守卫' })).toEqual({
      name: '工艺规则',
      note: '可读性守卫',
    });
    expect(KbGroupSaveInputSchema.parse({ name: '旧名', newName: '新名' }).newName).toBe('新名');
    expect(KbGroupSaveInputSchema.safeParse({ name: 'g', note: 'x'.repeat(501) }).success).toBe(false);
    expect(KbGroupSaveInputSchema.safeParse({ name: 'x'.repeat(65) }).success).toBe(false);
    expect(KbGroupDeleteInputSchema.parse({ name: 'g' })).toEqual({ name: 'g' });
  });

  it('KbEntrySave：value 1–20000 全量替换 + newKey 改名通道', () => {
    expect(KbEntrySaveInputSchema.parse({ group: 'g', key: 'k', value: 'v' })).toEqual({
      group: 'g',
      key: 'k',
      value: 'v',
    });
    expect(
      KbEntrySaveInputSchema.parse({ group: 'g', key: 'k', value: 'v', newKey: 'k2' }).newKey,
    ).toBe('k2');
    expect(KbEntrySaveInputSchema.safeParse({ group: 'g', key: 'k', value: '' }).success).toBe(false);
    expect(KbEntrySaveInputSchema.safeParse({ group: 'g', key: 'k', value: 'x'.repeat(20001) }).success).toBe(false);
    expect(KbEntryDeleteInputSchema.parse({ group: 'g', key: 'k' })).toEqual({ group: 'g', key: 'k' });
  });
});

describe('修订历史（git log/详情/恢复）', () => {
  const revision = { id: 'a1b2c3d', at: '2026-09-29T10:00:00+08:00', actor: 'admin:boss', summary: '新增条目「g/k」' };

  it('KbRevision 四字段；KbRevisionsOutput available=false 降级面（空表合法）', () => {
    expect(KbRevisionSchema.parse(revision)).toEqual(revision);
    expect(KbRevisionsOutputSchema.parse({ available: false, revisions: [] })).toEqual({
      available: false,
      revisions: [],
    });
    expect(KbRevisionsOutputSchema.safeParse({ available: true }).success).toBe(false);
  });

  it('修订 id：4–40 位十六进制；非 hex 拒（Get/Restore 同一约束）', () => {
    for (const id of ['a1b2', 'f'.repeat(40)]) {
      expect(KbRevisionGetInputSchema.parse({ id })).toEqual({ id });
      expect(KbRestoreInputSchema.parse({ id })).toEqual({ id });
    }
    for (const bad of ['HEAD~1', 'z1', 'abc', 'g'.repeat(41)]) {
      expect(KbRevisionGetInputSchema.safeParse({ id: bad }).success).toBe(false);
      expect(KbRestoreInputSchema.safeParse({ id: bad }).success).toBe(false);
    }
  });

  it('KbRevisionGetOutput：变更清单 A/M/D 三态 + 全量快照', () => {
    const detail = {
      revision,
      changes: [
        { path: '钻径与规格/SS 尺码表（SS6–SS34）.md', status: 'added' as const },
        { path: '旧.md', status: 'deleted' as const },
      ],
      snapshot: fullGroups.groups,
    };
    expect(KbRevisionGetOutputSchema.parse(detail)).toEqual(detail);
    expect(
      KbRevisionGetOutputSchema.safeParse({
        revision,
        changes: [{ path: 'a.md', status: 'renamed' }],
        snapshot: [],
      }).success,
    ).toBe(false);
  });

  it('KbRestore 输出 ok 布尔', () => {
    expect(KbRestoreOutputSchema.parse({ ok: true })).toEqual({ ok: true });
  });
});
