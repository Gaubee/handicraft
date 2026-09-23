/**
 * @handicraft/contracts 入口：前后端共享的全部线格式（Zod 真源）。
 * 原始需求 2026-09-23（add-backend-platform design §1/§3.5/§3.4——W0 冻结）。
 * 独立可发布：**不 import 引擎包**（rhinestone-studio），字段名/边界与引擎 schema 逐字面一致
 * （对照测试以引擎 types.ts 抄录的字面量断言，见 paving.test.ts 头注）。
 * 正交意图：barrel 聚合（公共标量 / 帧模型 / Agent 会话契约 / 排布参数契约 / 服务面任务端点）。
 */
export * from './common.js';
export * from './frame.js';
export * from './session.js';
export * from './paving.js';
export * from './tasks.js';
