/**
 * 素材库服务化契约测试（split-admin-portal 4.3 契约冻结面）：
 *   [1] 节点/树/写面 schema 形状（strict 拒杂质字段、nullable 语义、mime 白名单
 *       由服务端嗅探决定——schema 层只约束 nullable 形态）。
 *   [2] 迁移面：dir/image 判别联合（isDir 字面量判别）、批量上限边界。
 *   [3] 清单 payload 纯函数：hash 去重、字典序、同 hash 取最大 bytes、格式
 *       `<hash>:<bytes>\n`（两端 sha256 输入单源）。
 *   [4] migrateVerify 申报 digest 形状约束（hex64）。
 */
import { describe, expect, it } from 'vitest';
import {
  ASSETS_LIB_MIGRATE_BATCH_LIMIT,
  AssetsLibMigrateBatchInputSchema,
  AssetsLibMigrateImageItemSchema,
  AssetsLibMigrateVerifyInputSchema,
  AssetsLibNodeSchema,
  AssetsLibTreeInputSchema,
  assetsLibManifestPayload,
} from './assets-lib.js';

const VALID_HASH = 'a'.repeat(64);

function validNode() {
  return {
    id: 'al-1',
    owner: 'boss',
    parentId: null,
    name: '上传',
    isDir: true,
    mime: null,
    width: null,
    height: null,
    blobHash: null,
    bytes: 0,
    softDeleted: false,
    createdAt: '2026-09-29T00:00:00Z',
    updatedAt: '2026-09-29T00:00:00Z',
  };
}

describe('[1] 节点与树 schema', () => {
  it('目录节点通过；图片节点 mime/blobHash 非空通过', () => {
    expect(AssetsLibNodeSchema.parse(validNode())).toEqual(expect.objectContaining({ isDir: true }));
    const image = AssetsLibNodeSchema.parse({
      ...validNode(),
      isDir: false,
      mime: 'image/png',
      width: 120,
      height: 80,
      blobHash: VALID_HASH,
      bytes: 1024,
    });
    expect(image.blobHash).toBe(VALID_HASH);
  });

  it('blobHash 拒非 sha256 形状（hex64）；杂质字段拒（strict 语义沿各契约面）', () => {
    expect(() =>
      AssetsLibNodeSchema.parse({ ...validNode(), isDir: false, mime: 'image/png', blobHash: 'not-a-hash', bytes: 1 }),
    ).toThrow();
  });

  it('tree 入参：owner 可选+includeTrashed 缺省 false', () => {
    expect(AssetsLibTreeInputSchema.parse({}).includeTrashed).toBe(false);
    expect(AssetsLibTreeInputSchema.parse({ owner: 'boss', includeTrashed: true })).toEqual({
      owner: 'boss',
      includeTrashed: true,
    });
    expect(() => AssetsLibTreeInputSchema.parse({ owner: 'boss', surprise: 1 })).toThrow();
  });
});

describe('[2] 迁移面 schema', () => {
  it('dir/image 判别联合：image 项必须带 dataBase64，dir 项带 isDir:true 字面量', () => {
    const dir = AssetsLibMigrateBatchInputSchema.parse({
      items: [{ clientId: 'sys-uploads', name: '上传', parentClientId: null, isDir: true }],
    });
    expect(dir.items[0]!.isDir).toBe(true);

    const image = AssetsLibMigrateBatchInputSchema.parse({
      items: [
        {
          clientId: 'ast-1',
          name: 'pic.png',
          parentClientId: 'sys-uploads',
          isDir: false,
          dataBase64: 'iVBORw0KGgo=',
          width: 10,
          height: 10,
        },
      ],
    });
    expect(image.items).toHaveLength(1);
    // image 项缺 dataBase64 拒
    expect(() =>
      AssetsLibMigrateBatchInputSchema.parse({
        items: [{ clientId: 'ast-1', name: 'pic.png', parentClientId: null, isDir: false }],
      }),
    ).toThrow();
    // 判别键错误值拒
    expect(() =>
      AssetsLibMigrateImageItemSchema.parse({ clientId: 'x', name: 'y', parentClientId: null, isDir: true }),
    ).toThrow();
  });

  it('批量上限：超限拒、空批拒、恰好上限过', () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ clientId: `ast-${i}`, name: `d${i}`, parentClientId: null, isDir: true as const }));
    expect(() => AssetsLibMigrateBatchInputSchema.parse({ items: [] })).toThrow();
    expect(() => AssetsLibMigrateBatchInputSchema.parse({ items: mk(ASSETS_LIB_MIGRATE_BATCH_LIMIT + 1) })).toThrow();
    expect(AssetsLibMigrateBatchInputSchema.parse({ items: mk(ASSETS_LIB_MIGRATE_BATCH_LIMIT) }).items).toHaveLength(
      ASSETS_LIB_MIGRATE_BATCH_LIMIT,
    );
  });
});

describe('[3] 清单 payload 纯函数（两端 sha256 输入单源）', () => {
  const h = (c: string) => `${c}`.repeat(64);

  it('同 hash 多节点计一次（去重）；按 hash 字典序；行格式 `<hash>:<bytes>\\n`', () => {
    const payload = assetsLibManifestPayload([
      { blobHash: h('b'), bytes: 5 },
      { blobHash: h('a'), bytes: 3 },
      { blobHash: h('b'), bytes: 5 },
    ]);
    expect(payload).toBe(`${h('a')}:3\n${h('b')}:5\n`);
  });

  it('同 hash 不同 bytes（异常面）取最大——确定性不受输入序影响', () => {
    const one = assetsLibManifestPayload([
      { blobHash: h('a'), bytes: 3 },
      { blobHash: h('a'), bytes: 9 },
    ]);
    const two = assetsLibManifestPayload([{ blobHash: h('a'), bytes: 9 }]);
    expect(one).toBe(two);
  });

  it('空清单=空串', () => {
    expect(assetsLibManifestPayload([])).toBe('');
  });
});

describe('[4] verify 申报形状', () => {
  it('declaredDigest 拒非 hex64', () => {
    const base = { declaredCount: 1, declaredBytes: 10, declaredDigest: VALID_HASH };
    expect(AssetsLibMigrateVerifyInputSchema.parse(base)).toEqual(base);
    expect(() => AssetsLibMigrateVerifyInputSchema.parse({ ...base, declaredDigest: 'ZZ' + VALID_HASH.slice(2) })).toThrow();
  });
});
