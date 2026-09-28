/*
 * vitest 全局 setup（zhumo 方案移植块 B 2026-09-28）：jsdom 未实现
 * ResizeObserver——TranscriptView（贴底跟随）/UserBubble（溢出检测）/
 * ModelsConfig（tab 条横滚态）在挂载期使用。最小桩：observe/unobserve/
 * disconnect 空操作（浏览器内行为不受影响；测试断言不依赖观察回调）。
 * 各测试文件散置的 scrollIntoView/animate 桩维持原位（本文件只补全局缺口）。
 */
if (typeof globalThis.ResizeObserver !== 'function') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}
