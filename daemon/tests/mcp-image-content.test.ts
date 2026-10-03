/**
 * MCP 工具结果多模态提升测试（add-vision-pipeline-v2 T2.4 / design D5——dsh 工具面
 * 图像载荷通道）：capability/mcp.ts toToolResult 的约定字段（agentImagePreviews）
 * 提升 image content block；dataBase64 从 JSON 文本面剥离（防 token 双计）；无约定
 * 字段/failed/非法条目=既有纯文本行为逐字不变。零 IO。
 */
import { describe, expect, it } from 'vitest';
import { toToolResult } from '../src/capability/mcp.js';

const BLOB = 'a'.repeat(64);

function previewEntry(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'node-mask',
    nodeId: 'sam-node-0002',
    objectName: '右发',
    reason: 'mask-parent-iou',
    blobRef: BLOB,
    mime: 'image/png',
    maxSide: 512,
    dataBase64: 'aGVsbG8=',
    ...overrides,
  };
}

describe('toToolResult 多模态提升（agentImagePreviews 约定字段）', () => {
  it('无约定字段：纯文本行为逐字不变（envelope 原样序列化）', () => {
    const result = { kind: 'ok', value: { a: 1 } };
    const out = toToolResult(result);
    expect(out.isError).toBeUndefined();
    expect(out.content).toEqual([{ type: 'text', text: JSON.stringify(result, null, 2) }]);
  });

  it('携带约定字段：text 面剥离 dataBase64（元数据保留）+ image content block 追加', () => {
    const out = toToolResult({
      kind: 'ok',
      value: { status: 'done', treeArtifactRef: BLOB, agentImagePreviews: [previewEntry()] },
    });
    expect(out.content).toHaveLength(2);
    const text = out.content[0]!;
    expect(text.type).toBe('text');
    const parsed = JSON.parse((text as { text: string }).text) as {
      value: { agentImagePreviews: Array<Record<string, unknown>> };
    };
    // 文本面：dataBase64 剥离、blobRef/maxSide/reason 保留（agent 文本可寻址）
    expect(parsed.value.agentImagePreviews[0]!.dataBase64).toBeUndefined();
    expect(parsed.value.agentImagePreviews[0]!.blobRef).toBe(BLOB);
    expect(parsed.value.agentImagePreviews[0]!.reason).toBe('mask-parent-iou');
    // 图像面：MCP image content（LLM 真看图——D5 通道形态）
    const image = out.content[1]!;
    expect(image).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
  });

  it('failed/denied 结果不提升（isError 面）；非法条目忽略（预览缺席不影响结果语义）', () => {
    const failed = toToolResult({ kind: 'failed', code: 'UNAVAILABLE', message: 'x' });
    expect(failed.isError).toBe(true);
    expect(failed.content).toHaveLength(1);
    expect(failed.content[0]!.type).toBe('text');
    const bad = toToolResult({
      kind: 'ok',
      value: { agentImagePreviews: [previewEntry({ dataBase64: '' }), { kind: 'tree-overlay' }, null] },
    });
    expect(bad.content).toHaveLength(1); // 全部非法=纯文本原样（含未剥离原文）
    expect((bad.content[0] as { text: string }).text).toContain('dataBase64');
  });
});
