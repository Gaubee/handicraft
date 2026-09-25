/**
 * @handicraft/contracts 入口：前后端共享的全部线格式（Zod 真源）。
 * 原始需求 2026-09-23（add-backend-platform design §1/§3.5/§3.4——W0 冻结）；
 * 2026-09-24 增装饰钻库契约（add-stone-library S0：stones/color/stone-adapter）；
 * 同日增生产组合契约（add-stone-library S7.1：sets——set.json/限定名）；
 * 2026-09-25 增主体分割内核契约（add-subject-sam-pipeline P0.1：kernel——
 * object-tree/scene-analysis/strategy-plan/代码工件/常量/ppm 推导）。
 * 独立可发布：**不 import 引擎包**（rhinestone-studio），字段名/边界与引擎 schema 逐字面一致
 * （对照测试以引擎 types.ts 抄录的字面量断言，见 paving.test.ts 头注；ΔE/SS 数值同源
 * 对拍见 color.test.ts / stones.test.ts）。
 * 正交意图：barrel 聚合（公共标量 / 帧模型 / Agent 会话契约 / 排布参数契约 / 服务面任务端点 / 装饰钻库契约/生产组合契约）。
 */
export * from './common.js';
export * from './frame.js';
export * from './session.js';
export * from './paving.js';
export * from './tasks.js';
export * from './stones.js';
export * from './sets.js';
export * from './color.js';
export * from './stone-adapter.js';
export * from './kernel.js';
