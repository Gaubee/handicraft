/**
 * 提示词装配（照 shufa-server kernel/prompts.ts 形态移植——W4.1 贴钻版）。
 * 原始需求 2026-09-23：系统段（角色 + persona.md 全文注入）走 kernel preset 的
 * persona 行；任务段（编辑旅程提示词）归 W4.3——本波 followup 文本原样入会。
 * 正交意图：
 *   [1] 系统段：角色定位 + 产品手册（persona.md）全文注入（缺文件降级为最小说明）。
 *   [2] persona.md 路径（daemon/src/kernel/persona.md——初版，W4.3 旅程联调后迭代）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** persona 全文路径（kernel/prompts.ts 旁的 persona.md）。 */
export function defaultPersonaPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'persona.md');
}

/** 系统段（persona 行 config.text）。 */
export function buildSystemPersona(personaPath: string): string {
  let personaDoc: string;
  try {
    personaDoc = readFileSync(personaPath, 'utf8');
  } catch {
    personaDoc = [
      '# 贴钻产品手册（persona.md 缺失，降级说明）',
      '',
      '贴钻工作室把图片变成可打印可采购的钻画图纸（SVG/PNG/BOM）。',
      '改动一律先提议后批准：查询用只读工具；改动静值先出 diff 预览等用户批准。',
      '排布参数四件套：strategy（hex-thin/hex-pitch/poisson/hybrid/cvt）、density(0,1]、gapMm≥0、seed。',
    ].join('\n');
  }
  return [
    '你是「贴钻工作室」的贴钻助手。文件系统与 shell 不是本会话的能力面，',
    '一切经 studio.* 工具完成；任何改动静值（改密度/换色/换钻形、发起生成、导出）',
    '必须先产出 diff 预览提案、经用户在会话里批准后才能落盘——你拿不到「直接改」的通道。',
    '',
    personaDoc,
  ].join('\n');
}
