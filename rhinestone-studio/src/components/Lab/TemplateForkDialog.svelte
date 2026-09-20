<!--
TemplateForkDialog.svelte——模板复制表单弹窗（[UX-B] 统一模式：复制类动作 = Dialog 内
完整可编辑表单，从源记录预填全部字段，确认才创建副本；取消 = 零变更）。

字段面（与 TemplateEditor 同构，复用同一套 Input/Textarea 用法与 store 归一化口径）：
- 名称 / 候选数 / 提示词体：弹窗内草稿态（本地 $state），确认时经 forkTemplate 覆盖参数
  带入副本（candidates 钳制 1-8、prompt 截断与 submitTemplateField 同源）。
- 案例参照绑定：预览（getEffectRefCaseView 只读解析）+ [从素材库选]（assetPicker 单选）
  + [解绑]；上传/拼接合成管线属 TemplateEditor 的 EffectRefControl（写 store 记录），
  副本创建后可在编辑器内完成——弹窗不复制该实现。
- 高级选项（水钻参数配置/蓝图）：随源模板原样带入（forkTemplate 全键拷贝），弹窗呈现
  摘要只读行；修改归副本创建后的 TemplateAdvancedOptions。

重名：素材库 ingest 同父去重（uniqueNameAmong 自动加后缀）——沿既有后缀规则，无需内联提示。
-->

<script lang="ts">
  import { untrack } from 'svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import ButtonBusy from '../Studio/ButtonBusy.svelte'
  import { getEffectRefCaseView, type VariantEffectRef } from '$lib/stores/lab.svelte'
  import { forkTemplate, getTemplateRecord } from '$lib/stores/templates.svelte'
  import { assetPicker } from '$lib/assets/controller.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import type { LabCaseBinding } from '$lib/persistence/labFile'
  import FolderOpen from '@lucide/svelte/icons/folder-open'
  import ImageOff from '@lucide/svelte/icons/image-off'

  let {
    sourceAssetId = null as string | null,
    onclose,
  }: {
    /** 复制源（null = 关闭）。 */
    sourceAssetId?: string | null
    onclose: () => void
  } = $props()

  const source = $derived(sourceAssetId === null ? undefined : getTemplateRecord(sourceAssetId))

  // 草稿态：每次打开（源 id 变化）从源记录重置全部字段。
  // untrack：只跟踪 sourceAssetId——对话框开着时源 record 字段变化不重置用户草稿。
  let draftName = $state('')
  let draftPrompt = $state('')
  let draftCandidates = $state(2)
  let draftBinding = $state<LabCaseBinding | null>(null)
  let busy = $state(false)
  $effect(() => {
    const id = sourceAssetId
    untrack(() => {
      const src = id === null ? undefined : getTemplateRecord(id)
      draftName = `${src?.name || '未命名模板'} 副本`
      draftPrompt = src?.promptBody ?? ''
      draftCandidates = src?.candidates ?? 2
      draftBinding = src?.caseBinding === null || src?.caseBinding === undefined ? null : { ...src.caseBinding }
      busy = false
    })
  })

  /** 名称空（trim）不允许创建——内联提示。 */
  const nameError = $derived(draftName.trim() === '' ? '名称不能为空' : '')

  // 案例绑定预览（只读解析，同 EffectRefControl 口径）
  let bindingView = $state<{ url: string; name?: string } | null | undefined>(undefined)
  $effect(() => {
    const binding = draftBinding
    let cancelled = false
    bindingView = undefined
    if (binding) {
      const ref: VariantEffectRef = { kind: 'asset', assetId: binding.assetId, caseLayout: binding.caseLayout }
      void getEffectRefCaseView(ref).then((v) => {
        if (!cancelled) bindingView = v
      })
    } else {
      bindingView = null
    }
    return () => {
      cancelled = true
    }
  })

  async function pickBinding(): Promise<void> {
    if (busy) return
    const picked = await assetPicker.open({ multi: false })
    if (!picked || picked.length === 0) return
    draftBinding = { assetId: picked[0].id, caseLayout: 'single' }
  }

  async function confirmFork(): Promise<void> {
    const id = sourceAssetId
    if (id === null || busy || nameError !== '') return
    busy = true
    try {
      const created = await forkTemplate(id, {
        name: draftName,
        promptBody: draftPrompt,
        candidates: draftCandidates,
        caseBinding: draftBinding === null ? null : { ...draftBinding },
      })
      if (created !== null) {
        showToast(`已创建模板副本「${forkNameOf()}」`)
        onclose()
      }
    } finally {
      busy = false
    }
  }

  /** 成功 toast 用的展示名（fork 可能因重名被去重，此处仅提示意图名）。 */
  function forkNameOf(): string {
    return draftName.trim() === '' ? `${source?.name || '未命名模板'} 副本` : draftName.trim()
  }
</script>

<Dialog.Root open={sourceAssetId !== null} onOpenChange={(next) => !next && onclose()}>
  <Dialog.Content class="max-w-xl" data-testid="template-fork-dialog">
    <Dialog.Header>
      <Dialog.Title class="text-sm">复制模板</Dialog.Title>
      <Dialog.Description>
        预填源模板「{source?.name || '未命名模板'}」的全部字段，可修改后创建副本；取消不会产生任何变更。
      </Dialog.Description>
    </Dialog.Header>

    {#if source}
      <div class="grid grid-cols-1 gap-2">
        <div class="flex items-center gap-2">
          <Input
            class="h-8 flex-1 text-xs font-medium"
            value={draftName}
            oninput={(e) => (draftName = e.currentTarget.value)}
            aria-label="副本名称"
            placeholder="副本名称"
            data-testid="template-fork-name"
          />
          <label class="text-muted-foreground flex items-center gap-1 text-xs">
            候选
            <Input
              class="h-8 w-14 font-mono tabular-nums"
              type="number"
              min="1"
              max="8"
              value={draftCandidates}
              oninput={(e) => (draftCandidates = Number(e.currentTarget.value))}
              aria-label="候选数"
              data-testid="template-fork-candidates"
            />
          </label>
        </div>
        {#if nameError}
          <p class="text-destructive text-xs" role="alert">{nameError}</p>
        {/if}
        <Textarea
          class="field-sizing-content text-muted-foreground min-h-24 max-h-48 w-full min-w-0 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
          placeholder="英文生成指令"
          value={draftPrompt}
          oninput={(e) => (draftPrompt = e.currentTarget.value)}
          aria-label="生成指令"
          data-testid="template-fork-prompt"
        ></Textarea>

        <!-- 案例参照绑定：预览 + 从素材库选 / 解绑（上传合成管线归副本创建后的编辑器） -->
        <div class="grid gap-1.5 border-t pt-2">
          <span class="text-muted-foreground text-xs">案例参照图（随副本绑定）</span>
          <div class="flex items-center gap-1.5">
            <span
              class="ring-ring/40 relative flex h-14 w-28 shrink-0 items-center justify-center overflow-hidden rounded-md ring-1"
              data-testid="template-fork-binding-preview"
            >
              {#if bindingView?.url}
                <img src={bindingView.url} alt="案例参照合成图" class="size-full object-cover" draggable="false" />
              {:else if draftBinding && bindingView === null}
                <span class="text-muted-foreground flex flex-col items-center gap-1 text-[11px]">
                  <ImageOff class="size-4" aria-hidden="true" />
                  已失效
                </span>
              {:else if draftBinding}
                <span class="text-muted-foreground text-[11px]">加载中…</span>
              {:else}
                <span class="text-muted-foreground text-[11px]">未绑定</span>
              {/if}
            </span>
            <div class="flex flex-col gap-1">
              <Button variant="outline" size="xs" disabled={busy} onclick={() => void pickBinding()} data-testid="template-fork-pick">
                <FolderOpen />
                从素材库选
              </Button>
              <Button
                variant="ghost"
                size="xs"
                class="text-muted-foreground hover:text-destructive"
                disabled={busy || draftBinding === null}
                onclick={() => (draftBinding = null)}
                data-testid="template-fork-unbind"
              >
                解绑
              </Button>
            </div>
          </div>
        </div>

        <!-- 高级选项随带摘要（只读；修改归副本创建后的模板编辑器） -->
        <div class="text-muted-foreground grid gap-0.5 border-t pt-2 text-[11px] leading-relaxed">
          {#if source.drillParams !== undefined}
            <span>水钻参数配置：{source.drillParams.enabled ? '开' : '关'} · {source.drillParams.specs.length} 规格（随源带入）</span>
          {/if}
          {#if source.blueprint !== undefined}
            <span>蓝图效果：{source.blueprint.enabled ? '开' : '关'} · {(source.blueprint.refs ?? []).length} 原图（随源带入）</span>
          {/if}
          <span>高级选项与上传合成管线随源模板原样带入；创建副本后可在模板编辑器中修改。</span>
        </div>
      </div>
    {/if}

    <Dialog.Footer>
      <Button variant="ghost" size="sm" disabled={busy} onclick={onclose} data-testid="template-fork-cancel">
        取消
      </Button>
      <ButtonBusy
        busy={busy}
        size="sm"
        disabled={nameError !== ''}
        onclick={() => void confirmFork()}
        data-testid="template-fork-confirm"
      >
        创建副本
      </ButtonBusy>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
