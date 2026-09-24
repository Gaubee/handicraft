/**
 * 跨用户隔离探针（W4.2 R1 P1-1 修复验证——design.md:42 多账户互不可见）。
 * 覆盖：
 *   [1] 两用户两资源：B 的 agent 面（B 的任务上下文）enumerate 不到 A 的
 *       工程/模板；A 的面同构自洽。
 *   [2] export-dryrun / bom 以 A 的 resourceId 从 B 的任务调用=必拒
 *       （resourceId 反查 owner 与任务归属交叉校验）。
 *   [3] 工具 schema 面：四只读工具 taskId 必填（MCP 投影同一 Zod shape——
 *       模型侧无法以无身份参数调用）。
 * 测试纪律：进程内直调 registry（=MCP 环回投影的等效调用面）。
 */
import { describe, expect, it } from 'vitest';
import { ApprovalService } from '../src/capability/authorization.js';
import { publishLayoutDocument, type LayoutDocument } from '../src/capability/layout-doc.js';
import { createStudioCapabilities } from '../src/capability/studio.js';
import { createUser } from '../src/db/store.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createServices, type TestServices } from './helpers.js';
import { gridFromSpec, layout, mapColors, segment, STARTER_PALETTE } from 'rhinestone-studio/engine';
import { decodePng, encodePng } from '../src/png/codec.js';

/** 测试图：96×96 左半红右半蓝。 */
function twoColorPng(): Uint8Array {
  const w = 96;
  const h = 96;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
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

function makeLayoutDoc(): LayoutDocument {
  const bytes = twoColorPng();
  const d = decodePng(bytes);
  const img = { width: d.width, height: d.height, data: d.rgba };
  const blocks = segment(img as never, { k: 8, seed: 1, gemDiameterPx: 3 * 8 });
  const grid = gridFromSpec({ shapeId: 'round' as const, sizeLabel: '3mm', diameterMm: 3 }, 0.4, 8);
  const result = layout(blocks as never, 'hex-pitch', { density: 1, seed: 1, relax: { boundary: false, repulsion: false } }, grid);
  const gems = result.gems.map((gem) => ({ ...gem, shapeId: 'round' as const, diameterMm: 3 }));
  mapColors(gems as never, blocks as never, STARTER_PALETTE);
  return {
    kind: 'layout',
    version: 1,
    imageWidth: img.width,
    imageHeight: img.height,
    palette: STARTER_PALETTE as unknown as LayoutDocument['palette'],
    grid: grid as unknown as LayoutDocument['grid'],
    blocks: blocks as unknown as LayoutDocument['blocks'],
    gems: gems as unknown as LayoutDocument['gems'],
    dropped: result.dropped ?? 0,
    shapeAssets: {},
    pave: {
      strategy: 'hex-pitch',
      density: 1,
      seed: 1,
      relax: { boundary: false, repulsion: false },
      spec: { shapeId: 'round' as const, diameterMm: 3 },
      pixelsPerMm: 8,
    },
  };
}

interface Actor {
  user: TestServices['anonymous'];
  taskId: string;
  sessionId: string;
  resourceId: string;
  templateId: string;
}

describe('跨用户隔离（W4.2 R1 P1-1——多账户互不可见）', () => {
  it('B 的 agent 面 enumerate 不到 A 的工程/模板；A 的面自洽；跨用户 resourceId 必拒', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
      const registry = createStudioCapabilities({
        db: s.db,
        blobs: s.blobs,
        jobs: s.jobs,
        approvals: auth,
        config: s.config,
      });
      const doc = makeLayoutDoc();
      const mkActor = (user: TestServices['anonymous'], name: string): Actor => {
        const { sessionId } = s.sessions.create(user, { title: `${name} 会话` });
        const taskId = createAgentTask(s.db, { ownerId: user.id, sessionId, status: 'running' }).id;
        const published = publishLayoutDocument(s.db, s.blobs, user.id, `${name}.gemdoc`, doc);
        const templateId = `${name}-tpl`;
        s.db
          .prepare(
            "INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at) VALUES (?, ?, NULL, ?, 0, 'h', 10, ?, 1, ?, ?)",
          )
          .run(templateId, user.id, `${name}.gemtpl`, JSON.stringify({ kind: 'gemtpl', formatVersion: 2 }), new Date().toISOString(), new Date().toISOString());
        return { user, taskId, sessionId, resourceId: published.resourceId, templateId };
      };
      const a = mkActor(s.anonymous, 'A 的画');
      const bUser = createUser(s.db, { username: 'isolation-b', passwordHash: 'x', role: 'user' });
      const b = mkActor(bUser, 'B 的画');

      // [1] projects：B 的面只含 B 的资源（A 的 resourceId 零行）。
      const projectsOfB = (await registry.call('studio.projects', { taskId: b.taskId }, 'agent')) as {
        kind: string;
        value: { projects: Array<{ id: string }> };
      };
      expect(projectsOfB.kind).toBe('ok');
      const idsOfB = projectsOfB.value.projects.map((p) => p.id);
      expect(idsOfB).toContain(b.resourceId);
      expect(idsOfB).not.toContain(a.resourceId);
      expect(idsOfB).not.toContain(a.templateId);
      const projectsOfA = (await registry.call('studio.projects', { taskId: a.taskId }, 'agent')) as {
        value: { projects: Array<{ id: string }> };
      };
      expect(projectsOfA.value.projects.map((p) => p.id)).toContain(a.resourceId);

      // [1] templates：B 的面只含 B 的模板。
      const templatesOfB = (await registry.call('studio.templates', { taskId: b.taskId }, 'agent')) as {
        kind: string;
        value: { templates: Array<{ resourceId: string }> };
      };
      expect(templatesOfB.kind).toBe('ok');
      const tplIdsOfB = templatesOfB.value.templates.map((t) => t.resourceId);
      expect(tplIdsOfB).toContain(b.templateId);
      expect(tplIdsOfB).not.toContain(a.templateId);

      // [2] export-dryrun：B 的任务对 A 的 resourceId=必拒（即使 taskId 可选参数全对）。
      const dryrunCross = await registry.call('studio.export-dryrun', { taskId: b.taskId, resourceId: a.resourceId }, 'agent');
      expect(dryrunCross).toMatchObject({ kind: 'failed' });
      expect((dryrunCross as { message: string }).message).toContain('跨用户');
      // [2] bom：同构必拒。
      const bomCross = await registry.call('studio.bom', { taskId: b.taskId, resourceId: a.resourceId }, 'agent');
      expect(bomCross).toMatchObject({ kind: 'failed' });
      expect((bomCross as { message: string }).message).toContain('跨用户');
      // 正向对照：B 对自己的资源可预检/取 BOM。
      const dryrunSelf = await registry.call('studio.export-dryrun', { taskId: b.taskId, resourceId: b.resourceId }, 'agent');
      expect(dryrunSelf).toMatchObject({ kind: 'ok' });
      const bomSelf = await registry.call('studio.bom', { taskId: b.taskId, resourceId: b.resourceId }, 'agent');
      expect(bomSelf).toMatchObject({ kind: 'ok' });

      // [3] schema 面：无 taskId 的调用不进 handler（MCP 投影同一 shape——模型侧
      //     无法以无身份参数触达资源查询）。
      for (const name of ['studio.projects', 'studio.templates']) {
        const result = await registry.call(name, {}, 'agent');
        expect(result).toMatchObject({ kind: 'failed' });
        expect((result as { message: string }).message).toContain('参数不合法');
      }
      for (const name of ['studio.export-dryrun', 'studio.bom']) {
        const result = await registry.call(name, { resourceId: a.resourceId }, 'agent');
        expect(result).toMatchObject({ kind: 'failed' });
        expect((result as { message: string }).message).toContain('参数不合法');
      }
      // Zod shape 断言（MCP 注册直传该 shape）：缺 taskId 必不通过。
      for (const name of ['studio.projects', 'studio.templates', 'studio.export-dryrun', 'studio.bom']) {
        const definition = registry.definitionOf(name);
        expect(definition?.input.safeParse({ resourceId: 'x' }).success).toBe(false);
      }
    } finally {
      s.dispose();
    }
  });
});
