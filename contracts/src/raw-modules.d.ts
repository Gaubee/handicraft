/**
 * vite `?raw` 导入的通配模块声明（vitest transform 原生支持；tsc 需此声明解析）。
 * 仅测试消费（引擎源码文本对拍绊线——color.test.ts）；生产代码不使用。
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
