/**
 * 识图升级会话标题（scene-title，2026-10-02）聚焦测试：
 * ①sceneTitleFromAnalysis 合成规则——主体提取（顶层/滤 background/滤不值得贴/
 *   面积降序）、单主体直名、多主体前 2 并列、区域数附加条件、40 字上限、v1 平铺
 *   兼容、同名去重、无主体=undefined（不升级）。
 * ②applySceneAnalysisTitle 守门（经 db/sessions.applyKernelSessionTitle 单点）：
 *   fallback→provider→vision 三级升级顺序（同 task 最新胜）；user rename 永不
 *   被识图覆盖；异 task 不抢；title_owner NULL 时识图直落。firehose→守门的接线
 *   面归 kernel.test.ts title 投影块（本文件只测守门真源）。
 */
import { describe, expect, it } from 'vitest';
import type { SceneAnalysis, SceneElement } from '@handicraft/contracts';
import { createAgentTask } from '../src/db/jobs.js';
import { applyKernelSessionTitle, renameSessionRow } from '../src/db/sessions.js';
import {
  applySceneAnalysisTitle,
  SCENE_TITLE_MAX_CHARS,
  SCENE_TITLE_SOURCE_KIND,
  sceneTitleFromAnalysis,
} from '../src/kernel/vision/scene-title.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

function element(overrides: Partial<SceneElement> & Pick<SceneElement, 'name' | 'boxPx'>): SceneElement {
  return {
    hint: 'fixture',
    suggestDrillWorthy: true,
    parentElementId: null,
    ...overrides,
  };
}

function analysisOf(elements: SceneElement[], formatVersion: 1 | 2 = 2): SceneAnalysis {
  const normalized =
    formatVersion === 1
      ? elements.map(({ elementId: _id, parentElementId: _parent, relation: _relation, ...rest }) => rest)
      : elements;
  return {
    kind: 'scene-analysis',
    formatVersion,
    imageBlobRef: 'a'.repeat(64),
    canvasCm: { w: 30, h: 40 },
    imagePx: { width: 600, height: 800 },
    elements: normalized,
    createdAt: '2026-10-02T00:00:00.000Z',
  };
}

/** 走查同构 fixture：小丑主体（大盒）+ 部位（挂父）+ 黑背景（更大盒但 background）。 */
function clownElements(): SceneElement[] {
  return [
    element({
      name: '黑背景',
      category: 'background',
      boxPx: { x: 0, y: 0, w: 600, h: 800 },
      suggestDrillWorthy: false,
    }),
    element({ name: '小丑', elementId: 'el-clown', boxPx: { x: 100, y: 150, w: 400, h: 500 } }),
    element({
      name: '高帽',
      boxPx: { x: 200, y: 150, w: 100, h: 120 },
      elementId: 'el-hat',
      parentElementId: 'el-clown',
      relation: 'semantic',
    }),
    element({
      name: '卷发',
      boxPx: { x: 120, y: 300, w: 60, h: 80 },
      elementId: 'el-hair',
      parentElementId: 'el-clown',
      relation: 'semantic',
    }),
  ];
}

function titleRow(s: TestServices, sessionId: string): { title: string; title_owner: string | null } {
  return s.db.prepare('SELECT title, title_owner FROM sessions WHERE id = ?').get(sessionId) as {
    title: string;
    title_owner: string | null;
  };
}

// ---------------------------------------------------------------- 合成规则

describe('sceneTitleFromAnalysis（识图产物 → 标题素材合成）', () => {
  it('单主体：部位/黑背景不进标题——主体直名「小丑」（短名不加区域数）', () => {
    expect(sceneTitleFromAnalysis(analysisOf(clownElements()))).toBe('小丑');
  });

  it('多主体：取面积前 2 并列「小丑 · 花束」（显著性=面积降序，并列取数组序）', () => {
    const elements = [
      element({ name: '花束', elementId: 'el-1', boxPx: { x: 0, y: 0, w: 200, h: 300 } }),
      element({ name: '小丑', elementId: 'el-2', boxPx: { x: 0, y: 0, w: 500, h: 600 } }),
      element({ name: '礼物盒', elementId: 'el-3', boxPx: { x: 0, y: 0, w: 100, h: 100 } }),
    ];
    expect(sceneTitleFromAnalysis(analysisOf(elements))).toBe('小丑 · 花束');
  });

  it('同名去重；面积并列取数组序（确定性）', () => {
    const sameBox = { x: 0, y: 0, w: 50, h: 50 };
    const elements = [
      element({ name: '花', elementId: 'el-1', boxPx: sameBox }),
      element({ name: '花', elementId: 'el-2', boxPx: sameBox }),
      element({ name: '叶', elementId: 'el-3', boxPx: sameBox }),
    ];
    expect(sceneTitleFromAnalysis(analysisOf(elements))).toBe('花 · 叶');
  });

  it('suggestDrillWorthy=false（强灯光类）与 background 类同级滤除——全滤尽则 undefined（不升级）', () => {
    const elements = [
      element({
        name: '聚光灯',
        category: 'light',
        elementId: 'el-1',
        boxPx: { x: 0, y: 0, w: 80, h: 80 },
        suggestDrillWorthy: false,
      }),
      element({ name: '幕布背景', category: 'background', elementId: 'el-2', boxPx: { x: 0, y: 0, w: 600, h: 800 } }),
    ];
    expect(sceneTitleFromAnalysis(analysisOf(elements))).toBeUndefined();
  });

  it('v1 平铺工件兼容：无关系字段全员顶层（legacy「不按名称猜」——部位并列进标题）', () => {
    const flat = analysisOf(clownElements(), 1);
    expect(flat.elements.every((e) => e.parentElementId === undefined && e.elementId === undefined)).toBe(true);
    // 平铺面无从辨别部位（关系字段缺席=全员顶层）——取面积前 2：小丑+高帽并列。
    // 现行管线只产 v2（assembleAnalysis formatVersion=2），v1 仅历史工件。
    expect(sceneTitleFromAnalysis(flat)).toBe('小丑 · 高帽');
  });

  it('长主体名（>8 字）附区域数「（N 区域）」（N=元素总数含部位）；守 40 字上限', () => {
    // 10 字长名单主体 + 2 部位 = 3 元素 → 「…（3 区域）」
    const longName = '戴高帽的卷发小丑表演者';
    const elements = [
      element({ name: longName, elementId: 'el-main', boxPx: { x: 0, y: 0, w: 400, h: 500 } }),
      element({
        name: '高帽',
        elementId: 'el-hat',
        boxPx: { x: 0, y: 0, w: 50, h: 50 },
        parentElementId: 'el-main',
        relation: 'semantic',
      }),
      element({
        name: '卷发',
        elementId: 'el-hair',
        boxPx: { x: 0, y: 0, w: 40, h: 40 },
        parentElementId: 'el-main',
        relation: 'semantic',
      }),
    ];
    expect(sceneTitleFromAnalysis(analysisOf(elements))).toBe(`${longName}（3 区域）`);
    // 病理长名（schema name 无长度上限）：两长名并列+区域数 → 截到 40 字整。
    const huge = analysisOf([
      element({ name: '主'.repeat(20), elementId: 'el-main', boxPx: { x: 0, y: 0, w: 900, h: 900 } }),
      element({ name: '副'.repeat(20), elementId: 'el-sub', boxPx: { x: 0, y: 0, w: 500, h: 500 } }),
      element({
        name: '部位',
        elementId: 'el-part',
        boxPx: { x: 0, y: 0, w: 10, h: 10 },
        parentElementId: 'el-main',
        relation: 'semantic',
      }),
    ]);
    const title = sceneTitleFromAnalysis(huge);
    expect(title).toBeDefined();
    expect(title!.length).toBe(SCENE_TITLE_MAX_CHARS);
    expect(title!.startsWith('主'.repeat(20))).toBe(true);
  });
});

// ---------------------------------------------------------------- 守门（三级顺序）

describe('applySceneAnalysisTitle 守门（title_owner 单点——fallback→provider→vision）', () => {
  function seeded(s: TestServices, sessionId: string): string {
    return createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId }).id;
  }

  it('三级升级顺序：fallback → provider（同 task 覆盖）→ 识图（同 task 再覆盖）——识图产物最终胜出', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const { sessionId } = s.sessions.create(s.anonymous, { title: '' });
      const taskId = seeded(s, sessionId);
      applyKernelSessionTitle(s.db, taskId, '帮我排一幅钻石贴', 'fallback');
      expect(titleRow(s, sessionId)).toEqual({ title: '帮我排一幅钻石贴', title_owner: taskId });
      applyKernelSessionTitle(s.db, taskId, '贴钻任务', 'provider');
      expect(titleRow(s, sessionId)).toEqual({ title: '贴钻任务', title_owner: taskId });
      applySceneAnalysisTitle(s.db, taskId, analysisOf(clownElements()));
      expect(titleRow(s, sessionId)).toEqual({ title: '小丑', title_owner: taskId });
    } finally {
      s.dispose();
    }
  });

  it('user rename 永不被识图覆盖（pin）；异 task 的识图升级不抢会话标题', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const { sessionId } = s.sessions.create(s.anonymous, { title: '' });
      const task1 = seeded(s, sessionId);
      applyKernelSessionTitle(s.db, task1, '贴钻任务', 'provider');
      // 用户 rename：pin——同 task 识图升级不覆盖。
      renameSessionRow(s.db, sessionId, '我的定稿会话');
      applySceneAnalysisTitle(s.db, task1, analysisOf(clownElements()));
      expect(titleRow(s, sessionId)).toEqual({ title: '我的定稿会话', title_owner: 'user' });
      // 异 task（后续 followup=新 task）：即使未 pin 也不抢首个落地 task 的标题。
      const s2 = createServices(undefined, { imgDryRun: true });
      try {
        const { sessionId: sid2 } = s2.sessions.create(s2.anonymous, { title: '' });
        const owner = seeded(s2, sid2);
        const other = seeded(s2, sid2);
        applyKernelSessionTitle(s2.db, owner, '首任务标题', 'fallback');
        applySceneAnalysisTitle(s2.db, other, analysisOf(clownElements()));
        expect(titleRow(s2, sid2)).toEqual({ title: '首任务标题', title_owner: owner });
      } finally {
        s2.dispose();
      }
    } finally {
      s.dispose();
    }
  });

  it('title_owner NULL（插件 title 未落地/纯图首消息剥离为空）时识图直落为首个拥有者', () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const { sessionId } = s.sessions.create(s.anonymous, { title: '' });
      const taskId = seeded(s, sessionId);
      applySceneAnalysisTitle(s.db, taskId, analysisOf(clownElements()));
      expect(titleRow(s, sessionId)).toEqual({ title: '小丑', title_owner: taskId });
      // 无主体素材（全 background）：undefined 不落库——既有 title 不动。
      const before = titleRow(s, sessionId);
      applySceneAnalysisTitle(
        s.db,
        taskId,
        analysisOf([
          element({
            name: '幕布',
            category: 'background',
            elementId: 'el-bg',
            boxPx: { x: 0, y: 0, w: 9, h: 9 },
            suggestDrillWorthy: false,
          }),
        ]),
      );
      expect(titleRow(s, sessionId)).toEqual(before);
      // task 行缺失（非 daemon followup 面）：静默跳过不抛错。
      expect(() => applySceneAnalysisTitle(s.db, 'no-such-task', analysisOf(clownElements()))).not.toThrow();
    } finally {
      s.dispose();
    }
  });

  it('SCENE_TITLE_SOURCE_KIND 落库轨迹=自动源（vision——非 user，同 fallback/provider 门）', () => {
    expect(SCENE_TITLE_SOURCE_KIND).toBe('vision');
  });
});
