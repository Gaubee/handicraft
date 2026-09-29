<!--
WorkbenchRailDrawer.svelte——轨道 Drawer 开合容器（rework-workbench-rail-drawers 1.2，
design §1/§3：非模态覆盖式——absolute 定位盖画布、无全屏遮罩，画布在 Drawer 外
区域仍可交互）。视觉契约：bg-background/85 backdrop-blur-md、border-r/l、
transition-transform 200ms；收起态 translate-x-±full + invisible + pointer-events-none
（内容常驻 DOM——开合只切类，jsdom 断言走 data-open）。紧凑形态（@max-lg 容器断点）
全宽 w-full max-w-80（design §4 表）。z 序=20：压过画布观察控件（z-10）、低于 rail
工具条（z-30——rail 恒可点）。
-->

<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    side,
    open,
    label,
    testid,
    children,
  }: {
    /** 侧别：左=图层（w-72）；右=属性/历史（w-80）。 */
    side: 'left' | 'right'
    /** 生效开合（railState.isOpen 喂入）。 */
    open: boolean
    /** 无障碍标签。 */
    label: string
    /** 容器 testid（旧 slot testid 平移——图层/属性/历史槽位）。 */
    testid?: string
    children: Snippet
  } = $props()
</script>

<aside
  class="bg-background/85 backdrop-blur-md absolute inset-y-0 z-20 flex min-h-0 flex-col transition-transform duration-200 @max-lg:w-full @max-lg:max-w-80 {side === 'left'
    ? 'left-0 w-72 border-r'
    : 'right-0 w-80 border-l'} {open
    ? 'translate-x-0'
    : side === 'left'
      ? 'pointer-events-none invisible -translate-x-full'
      : 'pointer-events-none invisible translate-x-full'}"
  data-testid={testid}
  data-open={open ? 'true' : 'false'}
  data-side={side}
  aria-label={label}
  aria-hidden={open ? undefined : 'true'}
>
  {@render children()}
</aside>
