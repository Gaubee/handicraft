<!--
ResultCard.svelte — 结果卡片（W3.1：bundle 三产物下载 + 分享链接）。
mock 模式下载经 fixture 内联载荷（Agent 主面零服务器依赖）；rpc 模式的 blobRef
字节面归 W4 接线（下载按钮态如实降级，不假装可用）。
-->
<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import type { AgentResultView } from '$lib/agentApi/types'
  import { FIXTURE_BUNDLE_BYTES } from '$lib/agentApi/fixtures'
  import { getAgentMode, shareUrlOf } from '$lib/agentApi/store.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import Download from '@lucide/svelte/icons/download'
  import Link2 from '@lucide/svelte/icons/link-2'

  let { result }: { result: AgentResultView } = $props()

  const mode = $derived(getAgentMode())
  const shareUrl = $derived(result.publicId ? shareUrlOf(result) : null)

  function downloadBundle(key: 'svg' | 'bom' | 'png'): void {
    if (mode !== 'mock') {
      showToast('服务端模式下载将在 W4 接线后开放（blobRef → 服务端字节面）')
      return
    }
    const fixture = FIXTURE_BUNDLE_BYTES[key]
    let bytes: Blob
    if (key === 'png') {
      const base64 = fixture.content.split(',')[1] ?? ''
      bytes = new Blob([Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))], { type: fixture.mime })
    } else {
      bytes = new Blob([fixture.content], { type: fixture.mime })
    }
    const url = URL.createObjectURL(bytes)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fixture.name
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function copyShareLink(): Promise<void> {
    if (shareUrl === null) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      showToast('分享链接已复制')
    } catch {
      showToast(`分享链接：${shareUrl}`)
    }
  }
</script>

<div class="border-border/80 bg-card mx-auto w-full max-w-[85%] rounded-xl border p-4 shadow-sm" data-testid="result-card">
  <div class="mb-2 flex items-center gap-2">
    <Badge>结果就绪</Badge>
    {#if result.publicId}
      <span class="text-muted-foreground font-mono text-xs">/r/{result.publicId}</span>
    {/if}
  </div>
  <div class="flex flex-wrap items-center gap-2">
    <Button size="sm" variant="outline" data-testid="result-download-svg" onclick={() => downloadBundle('svg')}>
      <Download class="size-3.5" aria-hidden="true" />
      layout.svg
    </Button>
    <Button size="sm" variant="outline" data-testid="result-download-bom" onclick={() => downloadBundle('bom')}>
      <Download class="size-3.5" aria-hidden="true" />
      bom.csv
    </Button>
    <Button size="sm" variant="outline" data-testid="result-download-png" onclick={() => downloadBundle('png')}>
      <Download class="size-3.5" aria-hidden="true" />
      render.png
    </Button>
    {#if shareUrl !== null}
      <Button size="sm" variant="secondary" data-testid="result-share" onclick={copyShareLink}>
        <Link2 class="size-3.5" aria-hidden="true" />
        复制分享链接
      </Button>
    {/if}
  </div>
</div>
