import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  // 相对 base：子目录部署（gaubee.github.io/handicraft/rhinestone-studio/ 与 handicraft.gaubee.com/rhinestone-studio/ 双域名同构）
  base: './',
  plugins: [tailwindcss(), svelte()],
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
    },
    // vitest 走 node 条件会把 svelte 解析到 server 构建（mount 不可用），测试时切 browser 条件
    ...(process.env.VITEST ? { conditions: ['module', 'browser'] } : {}),
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    // [zhumo 方案移植块 B] 全局 jsdom 缺口桩（ResizeObserver——TranscriptView/
    // UserBubble/ModelsConfig 挂载期使用；详见 setup 文件头注）。
    setupFiles: ['src/tests/setup.jsdom.ts'],
  },
})
