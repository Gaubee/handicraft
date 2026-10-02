<!--
ResultCard.svelte — 结果卡片（W3.1：bundle 三产物下载 + 分享链接）。
mock 模式下载经 fixture 内联载荷（Agent 主面零服务器依赖）；rpc 模式下载走
/r/{publicId}/files/{key} 真字节面（W4 契约端点——同源静态托管，download 属性
强制落盘；publicId 缺失的已撤销/过期结果如实提示，不假装可用）。
[fixture 边界 2026-10-02] mock 模式的分享链接退场+「演示结果」标注——虚拟
publicId 拼 /r/ 会真打托管 daemon（404），不越域。
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
  const isMock = $derived(mode !== 'rpc')
  /** [fixture 边界] 分享链接只属 rpc 真结果（mock publicId=演示标记，不拼 URL）。 */
  const shareUrl = $derived(mode === 'rpc' && result.publicId ? shareUrlOf(result) : null)

  /** [真链复验 P1-C] rpc 模式下载文件名（/r/ 分享页同款三件套命名）。 */
  const RPC_DOWNLOAD_NAMES: Record<'svg' | 'bom' | 'png', string> = {
    svg: 'layout.svg',
    bom: 'bom.csv',
    png: 'render.png',
  }

  function downloadBundle(key: 'svg' | 'bom' | 'png'): void {
    if (mode !== 'mock') {
      // [真链复验 P1-C] 真字节面：/r/{publicId}/files/{key}（daemon http.ts 分享面，
      // 同源）——anchor download 属性强制下载而非导航。
      if (!result.publicId) {
        showToast('该结果无分享包（publicId 缺失——可能已撤销/过期），无法下载')
        return
      }
      const anchor = document.createElement('a')
      anchor.href = `/r/${encodeURIComponent(result.publicId)}/files/${key}`
      anchor.download = RPC_DOWNLOAD_NAMES[key]
      anchor.click()
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
      {#if isMock}
        <!-- [fixture 边界] 演示结果标注（不显 /r/ 路径——虚拟 publicId 不拼 URL）。 -->
        <Badge variant="outline" class="text-[10px]" data-testid="result-demo-badge">演示结果</Badge>
      {:else}
        <span class="text-muted-foreground font-mono text-xs">/r/{result.publicId}</span>
      {/if}
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
