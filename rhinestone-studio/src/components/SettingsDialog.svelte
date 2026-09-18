<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Badge } from '$lib/components/ui/badge'
  import { Separator } from '$lib/components/ui/separator'
  import { testConnection, type ConnectionTestResult } from '$lib/api/client'
  import { getSettings, updateSettings } from '$lib/stores/lab.svelte'
  import { closeSettings, isSettingsOpen } from '$lib/stores/settingsDialog.svelte'
  import Settings2 from '@lucide/svelte/icons/settings-2'
  import PlugZap from '@lucide/svelte/icons/plug-zap'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import CircleX from '@lucide/svelte/icons/circle-x'

  // [2026-09-18 R1] 开合收敛到全局 store：顶栏芯片 / sticky CTA / 失败卡「去设置」共用唯一挂载实例
  const open = $derived(isSettingsOpen())

  const settings = $derived(getSettings())

  let testing = $state(false)
  let testResult = $state<ConnectionTestResult | null>(null)

  /** 输入即时写入 store（runes 代理双向绑定），并即时持久化到 localStorage。 */
  function persist(): void {
    updateSettings({})
  }

  async function handleTest(): Promise<void> {
    testing = true
    testResult = null
    try {
      testResult = await testConnection({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
      })
    } finally {
      testing = false
    }
  }
</script>

<Dialog.Root
  open={open}
  onOpenChange={(next) => {
    if (!next) closeSettings()
  }}
>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        <Settings2 class="size-4" />
        BYOK 连接设置
      </Dialog.Title>
      <Dialog.Description>
        任意 OpenAI 兼容端点（官方 / 中转站）。API Key 仅存于本浏览器 localStorage，不会进入构建产物。
      </Dialog.Description>
    </Dialog.Header>

    <div class="grid gap-4 py-2">
      <label class="grid gap-1.5 text-sm">
        <span class="font-medium">Base URL</span>
        <Input
          bind:value={settings.baseUrl}
          oninput={persist}
          placeholder="https://api.openai.com/v1"
          autocomplete="off"
        />
        <span class="text-xs text-muted-foreground">自由填写，尾斜杠会自动归一（例：/v1/ 与 /v1 等价）。</span>
      </label>

      <label class="grid gap-1.5 text-sm">
        <span class="font-medium">API Key</span>
        <Input
          bind:value={settings.apiKey}
          oninput={persist}
          type="password"
          placeholder="sk-..."
          autocomplete="off"
        />
      </label>

      <label class="grid gap-1.5 text-sm">
        <span class="font-medium">模型</span>
        <Input bind:value={settings.model} oninput={persist} placeholder="gpt-image-2.5" autocomplete="off" />
        <span class="text-xs text-muted-foreground">自由文本，默认 gpt-image-2.5。</span>
      </label>

      <Separator />

      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" onclick={handleTest} disabled={testing}>
          {#if testing}
            <LoaderCircle class="animate-spin" />
          {:else}
            <PlugZap />
          {/if}
          连接测试
        </Button>
        {#if testResult}
          <span class="flex min-w-0 items-center gap-1.5 text-xs">
            {#if testResult.ok}
              <CircleCheck class="size-3.5 shrink-0 text-primary" />
              <span class="truncate text-muted-foreground">{testResult.message}</span>
            {:else}
              <CircleX class="size-3.5 shrink-0 text-destructive" />
              <span class="truncate text-destructive" title={testResult.message}>{testResult.message}</span>
            {/if}
          </span>
        {/if}
      </div>
      {#if testResult && !testResult.ok && testResult.errorKind === 'network'}
        <p class="text-xs text-muted-foreground">
          网络失败已与鉴权失败区分：鉴权类错误会显示 HTTP 401/403；纯网络失败多为中转站 CORS 未放行。
        </p>
      {/if}
    </div>

    <Dialog.Footer class="items-center sm:justify-between">
      <Badge variant="secondary">localStorage · rhinestone-studio:settings</Badge>
      <Dialog.Close>
        {#snippet child({ props })}
          <Button {...props}>完成</Button>
        {/snippet}
      </Dialog.Close>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
