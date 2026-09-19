<!--
Orthogonal intents (max 3):
1. [2026-09-18 R2] 实验室布局：桌面 400px 配置列 + 画廊主区（minmax(0,1fr)，各自独立滚动）；
   移动端单列自然流（配置 → 画廊 → 吸底 CTA）。
2. [2026-09-18 R2 PM-B1] 生成 CTA sticky：桌面钉在配置列底、移动端钉在视口底（底部 Tab 之上）；
   未配置 BYOK 时该按钮变「配置连接」（RunBar 内部实现）。
3. [4.6 openIntent] LabView = gemtpl/gemgen 打开意图的编排者（design §9.2 B3 + 补充稿 §B.2.4 七步）：
   App 只 peek 切视图，本组件 claim 后执行动线并 ack——claim 前零副作用（0.7 原子 claim 已
   保证并发多编排者一胜）；失败分支不清 token（failed 可诊断态）+ 留当前视图 + 单次 toast；
   仅目标卡展开且高亮挂载后才 ackSuccess。gemproj/gemdoc 意图不在本页消费（2.x/3.x 接管）。
-->

<script lang="ts">
  import { onMount, tick } from 'svelte'
  import Dropzone from '../../../components/Lab/Dropzone.svelte'
  import VariantEditor from '../../../components/Lab/VariantEditor.svelte'
  import RunBar from '../../../components/Lab/RunBar.svelte'
  import TaskQueue from '../../../components/Lab/TaskQueue.svelte'
  import PreviewDialog from '../../../components/Lab/PreviewDialog.svelte'
  import { hydrate } from '$lib/stores/lab.svelte'
  import {
    expandEntry,
    expandRun,
    findEntryByAssetId,
    GALLERY_FILTER_ALL,
    refreshGallery,
    sendGalleryEntry,
    setGalleryFilter,
  } from '$lib/stores/gallery.svelte'
  import {
    getTemplateAssetIds,
    isTemplatesReady,
    selectTemplate,
  } from '$lib/stores/templates.svelte'
  import {
    ackOpenIntentFailure,
    ackOpenIntentSuccess,
    claimOpenIntent,
    peekOpenIntent,
    type OpenIntentClaim,
  } from '$lib/stores/openIntent.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import { getView } from '$lib/stores/view.svelte'

  let previewOpen = $state(false)
  let previewEntryKey = $state<string | null>(null)

  // 组件卸载标记（B7 失败分支「组件卸载」：动线在途时切走视图 → ackFailure，不硬写已卸载 DOM）
  let disposed = false

  onMount(() => {
    void hydrate()
    return () => {
      disposed = true
    }
  })

  // ---------------------------------------------------------------------------
  // [4.6] openIntent 消费编排（gemtpl/gemgen；已在实验室或随视图切换挂载均响应）
  // ---------------------------------------------------------------------------

  /** 定位高亮类（2s 后由编排摘除；样式见文件尾 :global——TaskCard 4.5 冻结，命令式装饰其根节点）。 */
  const LOCATE_PULSE_CLASS = 'gallery-locate-pulse'
  const LOCATE_PULSE_MS = 2000

  $effect(() => {
    // 可见性门（bits-ui Tabs 恒挂载全部 Content、以 hidden 隐藏非激活页）：LabView 只在
    // 实验室为当前视图时 claim——未挂载/被隐藏时把意图留给「App 切视图 → 本 effect 重跑」，
    // 避免 claim 先于视图路由（App 只 peek 切视图，两侧时序解耦且均不丢意图）。
    if (getView() !== 'lab') return
    const snapshot = peekOpenIntent()
    if (snapshot === null || snapshot.phase !== 'pending') return
    // 通道统一四 kind，但本页只消费实验室两条动线；gemproj/gemdoc 留给 2.x/3.x 页面切片
    if (snapshot.kind !== 'gemtpl' && snapshot.kind !== 'gemgen') return
    // hydrate 就绪等待：templates store ready（hydrate 尾声置位）翻转后本 effect 重跑再 claim
    if (!isTemplatesReady()) return
    // 原子 claim（0.7 契约）：claim 之前零副作用——并发编排者/多 effect 竞争至多一胜
    const claim = claimOpenIntent()
    if (claim === null) return
    void runOpenIntent(claim)
  })

  async function runOpenIntent(claim: OpenIntentClaim): Promise<void> {
    try {
      if (claim.kind === 'gemtpl') await runGemtplFlow(claim)
      else if (claim.kind === 'gemgen') await runGemgenFlow(claim)
    } catch (error) {
      failIntent(
        claim,
        `unexpected:${claim.kind}`,
        `打开失败：${error instanceof Error ? error.message : String(error)}。已停留在当前视图。`,
      )
    }
  }

  /** 失败分支统一口（B3/B7）：ackFailure 不清 token（failed 可诊断态）+ 留当前视图 + 单次提示。 */
  function failIntent(claim: OpenIntentClaim, reason: string, message: string): void {
    const result = ackOpenIntentFailure(claim.token, reason)
    // 单次去重守卫：仅本 claim 仍是当前意图（ack 生效）才提示；'stale'（已被新意图替换）保持沉默
    if (result !== 'stale') showToast(message)
  }

  /** 左面板模板列表滚到可见（编辑焦点就位；best-effort——不在 B7 定位失败矩阵内）。 */
  function scrollTemplateIntoView(assetId: string): void {
    const section = document.querySelector('[data-testid="variant-editor"]')
    if (section === null) return
    const items = section.querySelectorAll('[data-slot="accordion-item"]')
    const index = getTemplateAssetIds().indexOf(assetId)
    const item = index >= 0 ? items[index] : null
    if (item === null) return
    try {
      item.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } catch {
      // jsdom 等无滚动实现环境：静默（选中态已生效，不阻断动线）
    }
  }

  /**
   * gemtpl 动线（§B.2.4「同链去 2/5/6」）：左面板选中 + chips 过滤 → ackSuccess，无定位段。
   * 模板已删/移出目录 → 失败分支（ackFailure + 单次 toast，不切视图）。
   */
  async function runGemtplFlow(claim: OpenIntentClaim): Promise<void> {
    if (!getTemplateAssetIds().includes(claim.assetId)) {
      failIntent(
        claim,
        `gemtpl-not-in-library:${claim.assetId}`,
        '模板已删除（或不在模板库），无法在实验室使用。可在回收站还原后重试。',
      )
      return
    }
    selectTemplate(claim.assetId)
    setGalleryFilter(claim.assetId)
    await tick()
    scrollTemplateIntoView(claim.assetId)
    ackOpenIntentSuccess(claim.token)
  }

  function galleryCardSelector(entryKey: string): string {
    return `[data-testid="gallery-entry"][data-entry-key="${entryKey}"]`
  }

  /**
   * gemgen 七步定位-展开动线（§B.2.4）：
   * 1 意图置位 + 解析先行已在 AssetsView 完成；2 本页 claim 后补扫库保证画廊投影含目标档案；
   * 3/4 溯源 templateAssetId（存在 → 左面板选中 + chips 过滤；缺失 → 回落「全部」+ 单次 toast）；
   * 5 目标组折叠先展开 → tick 等 DOM 重建 → data-testid 定位 → scrollIntoView(smooth/center)；
   * 6 加入展开集合 → tick 等展开挂载 → 高亮 pulse 挂载；7 高亮挂载后才 ackSuccess 清意图。
   */
  async function runGemgenFlow(claim: OpenIntentClaim): Promise<void> {
    await refreshGallery() // 幂等直扫（blobKey 不变不重解析）；TaskQueue 的合并刷新可能在途，不依赖
    if (disposed) {
      failIntent(claim, 'lab-view-unmounted', '定位已中断：实验室页面已切换。')
      return
    }

    const entry = findEntryByAssetId(claim.assetId)
    if (entry === undefined) {
      failIntent(
        claim,
        `gallery-entry-missing:${claim.assetId}`,
        '未能定位该生成结果（可能已被移入回收站）。已停留在当前视图。',
      )
      return
    }

    // 步骤 3/4：溯源回链
    const templateAssetId = entry.templateAssetId
    if (templateAssetId !== undefined && getTemplateAssetIds().includes(templateAssetId)) {
      selectTemplate(templateAssetId)
      setGalleryFilter(templateAssetId)
    } else {
      setGalleryFilter(GALLERY_FILTER_ALL)
      showToast('模板已删除（或不在模板库），已定位到结果')
    }

    // 步骤 5：目标组折叠先展开（不动其他组）→ 过滤重算 → tick 等 DOM 重建
    expandRun(entry.runId)
    await tick()
    if (disposed) {
      failIntent(claim, 'lab-view-unmounted', '定位已中断：实验室页面已切换。')
      return
    }
    if (templateAssetId !== undefined && getTemplateAssetIds().includes(templateAssetId)) {
      scrollTemplateIntoView(templateAssetId)
    }

    const card = disposed ? null : document.querySelector(galleryCardSelector(entry.key))
    if (card === null) {
      if (disposed) {
        failIntent(claim, 'lab-view-unmounted', '定位已中断：实验室页面已切换。')
        return
      }
      failIntent(
        claim,
        `gallery-dom-missing:${entry.key}`,
        '未能定位该生成结果的卡片（画廊尚未渲染完成）。已停留在当前视图。',
      )
      return
    }
    try {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } catch (error) {
      failIntent(
        claim,
        `scroll-failed:${entry.key}`,
        `定位滚动失败：${error instanceof Error ? error.message : String(error)}。已停留在当前视图。`,
      )
      return
    }

    // 步骤 6：展开 + 2s 高亮（一次性，不锁定滚动/状态）
    expandEntry(entry.key)
    await tick()
    const expandedCard = disposed ? null : document.querySelector(galleryCardSelector(entry.key))
    if (expandedCard === null) {
      if (disposed) {
        failIntent(claim, 'lab-view-unmounted', '定位已中断：实验室页面已切换。')
        return
      }
      failIntent(
        claim,
        `gallery-dom-missing-after-expand:${entry.key}`,
        '未能定位该生成结果的卡片（画廊尚未渲染完成）。已停留在当前视图。',
      )
      return
    }
    expandedCard.classList.add(LOCATE_PULSE_CLASS, 'animate-pulse')
    // 步骤 7：高亮已挂载 → 清意图；2s 后撤高亮（fire-and-forget，元素已卸载亦无害）
    ackOpenIntentSuccess(claim.token)
    setTimeout(() => expandedCard.classList.remove(LOCATE_PULSE_CLASS, 'animate-pulse'), LOCATE_PULSE_MS)
  }

  function openPreview(entryKey: string): void {
    previewEntryKey = entryKey
    previewOpen = true
  }

  async function handleSend(entryKey: string): Promise<void> {
    const ok = await sendGalleryEntry(entryKey)
    if (!ok) return
    previewOpen = false
    // 视图切换：App.svelte 的 handoff $effect；确认反馈：全局 toast「已送入排钻设计」
  }
</script>

<div
  class="flex h-full min-h-0 flex-col overflow-y-auto pb-24 lg:grid lg:grid-cols-[400px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto] lg:overflow-hidden lg:pb-0"
>
  <!-- 配置列（桌面左 400px，独立滚动；移动端自然流） -->
  <div class="flex flex-col gap-4 p-4 pb-3 lg:col-start-1 lg:row-start-1 lg:min-h-0 lg:overflow-y-auto lg:border-r">
    <Dropzone />
    <VariantEditor />
  </div>

  <!-- 画廊主区（桌面右列整高滚动；移动端跟随主滚动） -->
  <div class="p-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:min-h-0 lg:overflow-y-auto">
    <TaskQueue onopenpreview={openPreview} />
  </div>

  <!-- 吸底生成 CTA：移动端 sticky 视口底；桌面钉在配置列底部 -->
  <div
    class="bg-background/95 sticky bottom-0 z-20 border-t p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] backdrop-blur lg:col-start-1 lg:row-start-2"
    data-testid="run-bar-slot"
  >
    <RunBar />
  </div>
</div>

<PreviewDialog bind:open={previewOpen} bind:entryKey={previewEntryKey} onsend={(key) => void handleSend(key)} />

<style>
  /*
   * [4.6] 定位高亮：类由上方编排命令式挂到 TaskCard 根节点（data-testid="gallery-entry"，
   * B7 冻结 DOM 约定；TaskCard 内部 4.5 冻结不改）——描边 + 呼吸脉冲（animate-pulse tailwind
   * 类同由编排挂上），2s 后摘除。:global 必须：目标元素属 TaskQueue/TaskQueue 子树。
   */
  :global(.gallery-locate-pulse) {
    outline: 2px solid var(--color-ring);
    outline-offset: 2px;
    box-shadow: 0 0 0 4px color-mix(in oklab, var(--color-ring) 25%, transparent);
  }
</style>
