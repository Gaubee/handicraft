<!--
TemplateEditSheet.svelte——gemtpl 编辑 RightSheet（openspec add-project-files 4.3b；
补充稿 §C.5 [Owner 2026-09-19 追加裁决]）。

TemplateEditor 的**第二宿主**（第一宿主 = 实验室手风琴，C.5.3）：本组件只提供宿主
chrome——头部保存态指示 + 独立滚动体 + 关闭状态机；编辑四件套整体复用 TemplateEditor，
record 一律读 templates store 共享 $state，宿主不持编辑副本（PRODUCT_MODEL 硬规则 7）。

关闭状态机（design §9.3 E4/B4，冻结）：
  open=true --三入口请求关闭--> flushing --写队列排空且无错--> open=false
                                      └--写失败--> open=true,error（不丢焦点/缓冲，
                                        弹三选 mini Dialog：重试保存 / 放弃修改并关闭 /
                                        继续编辑；仅「放弃修改」走 revertTemplateFields）

受控落地方式：bits-ui 的全部内建关闭路径（Escape / 点击 overlay / 内建 ✕）都被
preventDefault 接管并改道 requestClose——Sheet 的 open **从不**经由 bits-ui 自行翻转
（open 真源 = templateSheet store），因此「flush 失败禁止关闭」在 DOM 层成立：Sheet
不动画退出、焦点与未提交 DOM 缓冲原位保留。三入口等价性由「全部汇入同一 attemptSave」
构造性保证。

移动端落点（C.5.2）：全宽 + 顶部拖拽把手（视觉指示，关闭仍走三入口状态机）+ 底部
safe-area padding + 输入控件 ≥16px 防 iOS 聚焦自动缩放（组件尾部样式块，仅粗指针/窄屏
生效，桌面维持与实验室同构的紧凑字号）。
-->

<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import TemplateEditor from '../Lab/TemplateEditor.svelte'
  import { closeTemplateSheet, getTemplateSheetAssetId } from '$lib/stores/templateSheet.svelte'
  import {
    getTemplatePersistedSnapshot,
    getTemplateRecord,
    revertTemplateFields,
    submitTemplateField,
    whenTemplatesIdle,
    type TemplateFieldPatch,
    type TemplateRecord,
  } from '$lib/stores/templates.svelte'

  /** 编辑中删除终态的自动关闭延迟（「模板已删除」文案的可见窗口）。 */
  const DELETED_AUTO_CLOSE_MS = 900

  const assetId = $derived(getTemplateSheetAssetId())
  const sheetOpen = $derived(assetId !== null)
  const record = $derived(assetId === null ? undefined : getTemplateRecord(assetId))

  // —— 关闭状态机（idle → flushing → closed|error；error 态 open 保持 true）——
  let closePhase = $state<'idle' | 'flushing' | 'error'>('idle')
  /** flush 失败后的三选救援 Dialog。 */
  let rescueOpen = $state(false)
  /** 「模板已删除」终态（sheet 开着但共享 record 已消失）。 */
  let deletedTerminal = $state(false)

  // —— 状态机内部量（刻意非响应式：不参与渲染，避免 $effect 读写环）——
  /**
   * flush 提交过的补丁 = 失败后的「重试保存」载荷（失败路径已把 record 回退到快照，
   * 重试需重放补丁）。这不是「宿主持编辑副本」：它只在 flush 失败 → 救援抉择窗口
   * 内存活，成功落盘 / 继续编辑 / 关闭即清空。
   */
  let lastFlushPatch: TemplateFieldPatch | null = null
  /** 本次 flush 是否携带关闭意图（三入口 = true；头部 [重试] = false）。 */
  let closeIntent = false

  // —— 编辑中模板被删（C.5.4）：转「模板已删除」终态 + 自动关闭；在途 flush 由
  //    templates store 的 disposed 熔断承接（不再写盘），本侧只需收口 UI ——
  $effect(() => {
    const id = getTemplateSheetAssetId()
    if (id === null || getTemplateRecord(id) !== undefined) {
      deletedTerminal = false
      return
    }
    deletedTerminal = true
    const timer = setTimeout(() => closeTemplateSheet(), DELETED_AUTO_CLOSE_MS)
    return () => clearTimeout(timer)
  })

  // ---------------------------------------------------------------------------
  // 关闭状态机
  // ---------------------------------------------------------------------------

  /**
   * flush 探针：一次性读取 Sheet 内尚未 onchange（未 blur）的 DOM 字段现值，与共享
   * record 对比产出补丁。只读不订阅，不构成编辑副本；jsdom/浏览器同构（change 未派发
   * = 未提交，与 TemplateEditor 的 onchange 提交语义互补——已 blur 的值早已入队）。
   */
  function probeUncommitted(rec: TemplateRecord): TemplateFieldPatch | null {
    const root = document.querySelector('[data-testid="template-edit-sheet"]')
    if (root === null) return null
    const patch: TemplateFieldPatch = {}
    let touched = false
    const nameInput = root.querySelector('[data-testid="template-name-input"]')
    if (nameInput instanceof HTMLInputElement && nameInput.value !== rec.name) {
      patch.name = nameInput.value
      touched = true
    }
    const candidatesInput = root.querySelector('[data-testid="template-candidates-input"]')
    if (
      candidatesInput instanceof HTMLInputElement &&
      candidatesInput.value !== String(rec.candidates)
    ) {
      patch.candidates = Number(candidatesInput.value)
      touched = true
    }
    const promptArea = root.querySelector('[data-testid="template-prompt-textarea"]')
    if (promptArea instanceof HTMLTextAreaElement && promptArea.value !== rec.promptBody) {
      patch.promptBody = promptArea.value
      touched = true
    }
    return touched ? patch : null
  }

  /** 探针补丁优先（失败后用户可能又改过）；缺字段落 lastFlushPatch（重试载荷）兜底。 */
  function mergeFlushPatch(probe: TemplateFieldPatch | null): TemplateFieldPatch | null {
    const pick = <K extends keyof TemplateFieldPatch>(key: K): TemplateFieldPatch[K] | undefined =>
      probe?.[key] !== undefined ? probe[key] : lastFlushPatch?.[key]
    const merged: TemplateFieldPatch = {}
    let touched = false
    const name = pick('name')
    if (name !== undefined) {
      merged.name = name
      touched = true
    }
    const promptBody = pick('promptBody')
    if (promptBody !== undefined) {
      merged.promptBody = promptBody
      touched = true
    }
    const candidates = pick('candidates')
    if (candidates !== undefined) {
      merged.candidates = candidates
      touched = true
    }
    const caseBinding = pick('caseBinding')
    if (caseBinding !== undefined) {
      merged.caseBinding = caseBinding
      touched = true
    }
    return touched ? merged : null
  }

  function finishClose(): void {
    closePhase = 'idle'
    rescueOpen = false
    lastFlushPatch = null
    closeTemplateSheet()
  }

  /** record 与最后成功快照是否有发散（救援触发面：冲突保留态等 record≠磁盘 的中间态）。 */
  function recordDivergesFromSnapshot(rec: TemplateRecord): boolean {
    const snap = getTemplatePersistedSnapshot(rec.assetId)
    if (snap === undefined) return true // 无持久快照（文件损坏态）→ 交救援人工处置
    if (
      rec.name !== snap.name ||
      rec.promptBody !== snap.promptBody ||
      rec.candidates !== snap.candidates
    ) {
      return true
    }
    if ((rec.caseBinding === null) !== (snap.caseBinding === null)) return true
    return (
      rec.caseBinding !== null &&
      snap.caseBinding !== null &&
      (rec.caseBinding.assetId !== snap.caseBinding.assetId ||
        rec.caseBinding.caseLayout !== snap.caseBinding.caseLayout)
    )
  }

  /**
   * 统一 flush（design §9.3 E4 关闭状态机的唯一实现；三入口 overlay/Escape/[完成]、
   * 头部 [重试]、救援 [重试保存] 全部经此）：
   *
   *   ① 排空请求时刻的在途写（onchange 已入队但未落地的写、CAS 冲突追加轮次——其
   *      失败回退/重试在 drain 内收敛，之后的 record 态才是可判定的基线）；
   *   ② flush 探针：把 Sheet 内未 blur 的 DOM 字段值经 submitTemplateField 入队；
   *   ③ 再排空 → 无错（或错误已被 store 完全处置：record=快照=磁盘 且无重试载荷）
   *      按意图关闭；否则转 error 态：open 保持 true（不丢焦点/缓冲）+ 三选救援。
   *
   * 「已处置的陈旧失败」判定的时序依据：写失败时 store 已同步回退 record 到快照并
   * toast（4.3 语义，与实验室单宿主一致）；此时 record=快照=磁盘，重试无载荷、放弃
   * 无对象——救援 Dialog 会变成死循环，故按可安全关闭处理（残余错误仍显示在头部）。
   */
  async function attemptSave(withClose: boolean): Promise<void> {
    const id = getTemplateSheetAssetId()
    if (id === null) return
    if (closePhase === 'flushing') return // 重入保护：flush 进行中忽略新请求
    if (getTemplateRecord(id) === undefined) {
      finishClose() // 已删终态：无可 flush，直接收口
      return
    }
    closeIntent = withClose
    closePhase = 'flushing'
    try {
      await whenTemplatesIdle() // ① 排空进入前已在途的写
      let rec = getTemplateRecord(id)
      if (rec === undefined) {
        finishClose() // flush 期间被删：disposed 熔断已止写，直接关
        return
      }
      const patch = mergeFlushPatch(probeUncommitted(rec)) // ② 未 blur 字段入队
      if (patch !== null) {
        lastFlushPatch = patch
        submitTemplateField(id, patch)
        await whenTemplatesIdle() // ③ 排空本次 flush 的写
        rec = getTemplateRecord(id)
        if (rec === undefined) {
          finishClose()
          return
        }
      }
      if (rec.lastError === null || (lastFlushPatch === null && !recordDivergesFromSnapshot(rec))) {
        lastFlushPatch = null
        if (closeIntent) finishClose()
        else closePhase = 'idle'
        return
      }
      // 本次 flush 失败（有重试载荷或 record 与磁盘发散）：禁止关闭，转三选
      closePhase = 'error'
      rescueOpen = true
    } catch {
      closePhase = 'error'
      rescueOpen = true
    }
  }

  /** 防御位：内建关闭路径已被 preventDefault 接管，此回调正常流不可达；若漏网统一改道状态机。 */
  function onSheetOpenChange(next: boolean): void {
    if (!next) void attemptSave(true)
  }

  /** 救援①：重试保存——重放失败补丁再走一轮 flush；按原关闭意图决定成功后是否关闭。 */
  function rescueRetry(): void {
    rescueOpen = false
    closePhase = 'idle'
    void attemptSave(closeIntent)
  }

  /** 救援②：放弃修改并关闭——record 回退最后成功快照（磁盘不动）后关（design §9.3 E4）。 */
  function rescueDiscard(): void {
    const id = getTemplateSheetAssetId()
    if (id !== null) revertTemplateFields(id)
    finishClose()
  }

  /** 救援③：继续编辑——留 Sheet 关 Dialog，丢弃重试载荷（编辑交还用户）。 */
  function rescueContinue(): void {
    rescueOpen = false
    closePhase = 'idle'
    lastFlushPatch = null
  }

  function formatClock(ts: number): string {
    const d = new Date(ts)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
</script>

<Sheet.Root open={sheetOpen} onOpenChange={onSheetOpenChange}>
  <Sheet.Content
    side="right"
    showCloseButton={false}
    class="w-full gap-0 sm:max-w-[520px]"
    data-testid="template-edit-sheet"
    onEscapeKeydown={(e) => {
      e.preventDefault()
      void attemptSave(true)
    }}
    onInteractOutside={(e) => {
      e.preventDefault()
      void attemptSave(true)
    }}
  >
    <!-- 移动端顶部拖拽把手（C.5.2 视觉指示；关闭统一走状态机） -->
    <div
      class="bg-border mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full sm:hidden"
      aria-hidden="true"
      data-testid="template-sheet-handle"
    ></div>

    <Sheet.Header class="flex-row items-center gap-2 border-b px-4 pt-2 pb-3">
      <Sheet.Title
        class="min-w-0 flex-1 truncate text-sm font-medium"
        data-testid="template-sheet-title"
      >
        {record?.name || '未命名模板'}
      </Sheet.Title>
      {#if closePhase === 'flushing' || record?.saving}
        <span class="text-muted-foreground shrink-0 text-[11px]" data-testid="template-sheet-saving">
          保存中…
        </span>
      {:else if record?.lastError}
        <span class="text-destructive shrink-0 text-[11px]" role="alert" data-testid="template-sheet-error">
          保存失败
        </span>
        <button
          type="button"
          class="text-primary hover:underline shrink-0 cursor-pointer text-[11px]"
          onclick={() => void attemptSave(false)}
          data-testid="template-sheet-retry"
        >
          重试
        </button>
      {:else if record}
        <span class="text-muted-foreground shrink-0 text-[11px]" data-testid="template-sheet-saved">
          已保存 {formatClock(record.savedAt)}
        </span>
      {/if}
      <Button
        variant="outline"
        size="sm"
        class="shrink-0"
        onclick={() => void attemptSave(true)}
        data-testid="template-sheet-done"
      >
        完成
      </Button>
    </Sheet.Header>
    <Sheet.Description class="sr-only">
      编辑模板的名称、候选数、提示词与案例参照绑定；修改自动保存回素材库。
    </Sheet.Description>

    <!-- 体部独立滚动 = TemplateEditor（与实验室同构；底部 safe-area padding；
         flushing 期间 inert——防排空等待中继续输入产生的二次未提交缓冲竞态） -->
    <div
      class="sheet-body min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
      inert={closePhase === 'flushing' ? true : undefined}
      aria-busy={closePhase === 'flushing' ? 'true' : undefined}
      data-testid="template-sheet-body"
    >
      {#if deletedTerminal}
        <p class="text-muted-foreground py-8 text-center text-xs" data-testid="template-sheet-deleted">
          模板已删除，编辑已关闭。
        </p>
      {:else if assetId !== null && record !== undefined}
        <TemplateEditor templateAssetId={assetId} />
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>

<!-- 三选救援 Dialog（flush 失败；portal 悬浮于 Sheet 之上）。Escape/外点被接管：数据在
     风险上，三选必须显式抉择（重试 / 放弃 / 继续编辑），不做隐式dismiss。 -->
<Dialog.Root bind:open={rescueOpen}>
  <Dialog.Content
    class="max-w-sm"
    data-testid="template-sheet-rescue"
    onEscapeKeydown={(e) => e.preventDefault()}
    onInteractOutside={(e) => e.preventDefault()}
  >
    <Dialog.Header>
      <Dialog.Title>保存失败</Dialog.Title>
      <Dialog.Description>
        「{record?.name || '未命名模板'}」的修改未能写入素材库{record?.lastError
          ? `（${record.lastError}）`
          : ''}。已恢复为上次保存的值；可重试保存，或放弃修改后关闭。
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="ghost" size="sm" onclick={rescueContinue} data-testid="rescue-continue">
        继续编辑
      </Button>
      <Button variant="outline" size="sm" onclick={rescueDiscard} data-testid="rescue-discard">
        放弃修改并关闭
      </Button>
      <Button size="sm" onclick={rescueRetry} data-testid="rescue-retry">
        重试保存
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  /* C.5.2 移动端落点：粗指针/窄屏下正文输入控件 ≥16px，防 iOS 聚焦自动缩放。
     桌面（hover 精确指针）维持与实验室手风琴同构的 text-xs 紧凑字号。 */
  @media (pointer: coarse), (max-width: 639px) {
    .sheet-body :global(textarea),
    .sheet-body :global(input) {
      font-size: 16px;
    }
  }
</style>
