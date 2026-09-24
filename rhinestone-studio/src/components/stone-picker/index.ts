/**
 * 钻表选择器组件库出口（add-stone-library S5——纯组件交付，不挂路由）。
 * P3.2 策略层参数面板消费形态：
 *   const store = new StonePickerStore(source)
 *   <StonePicker {store} onPick={(pick) => …} />
 * 数据源注入：测试 mock（StonePickerSource 直造）/ 生产 createRpcStonePickerSource()
 * （nearColor 与 activeSetId 的协议位判定见 lib/stonePicker/source.ts 头注）。
 */
export { default as StonePicker } from './StonePicker.svelte'
export { default as StoneCellTile } from './StoneCellTile.svelte'
