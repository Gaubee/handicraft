#!/usr/bin/env tsx
/**
 * 引擎 smoke gate 脚本入口（tsx=daemon 实际运行时——与 vitest 双轨：
 * tsx 证明运行时消费，vitest 提供回归门禁）。
 */
import { runEngineSmoke } from '../src/engine-smoke.js';

const result = runEngineSmoke();
console.log('[engine-smoke] PASS', JSON.stringify(result));
