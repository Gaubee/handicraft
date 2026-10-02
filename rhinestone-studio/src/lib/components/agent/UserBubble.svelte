<!--
  用户消息气泡（走查 R7：替换溢出滚动——滚动破坏阅读连续性）：
  - 折叠态 line-clamp 收起 + 底部渐变遮罩 + bottom-center「展开」按钮；
  - 展开态完整内容 + bottom-center「收起」按钮；
  - 内容未溢出时不显示任何按钮（scrollHeight 检测）。
  [split-admin-portal 2.6.4] 附件 chip 行（帧回放元数据）：缩略图+文件名。
  [T3 2026-10-01] 气泡下方右对齐工具条（assistant 同款 opacity-0 group-hover
  语义）：[copy 钮（打勾 1.5s）][时间戳（ts props——无 ts 不显）]；折叠阈值
  max-h-[114px]=6 行×19px 行高（6 行内完整显示）。
  [T4 2026-10-01] 附件 chip 点击开应用内 Lightbox（不再 a href 直跳新窗口）：
  本组件自持 Lightbox（items=当前气泡 attachments，index=点击项）；纯图消息
  （空文本）同样生效。
-->
<script lang="ts">
  import IconChevronDown from "@lucide/svelte/icons/chevron-down";
  import IconChevronUp from "@lucide/svelte/icons/chevron-up";
  import IconCheck from "@lucide/svelte/icons/check";
  import IconCopy from "@lucide/svelte/icons/copy";
  import IconInfo from "@lucide/svelte/icons/info";
  import MarkdownRender from "markstream-svelte";
  import { agentAssetUrl } from "$lib/agentApi/assetBoundary"
  import { retryRawImageOnError, type AttachmentMeta } from "$lib/agentApi/attachments";
  import { formatMessageTime } from "$lib/agentApi/transcript.svelte";
  import Lightbox from "./Lightbox.svelte";

  let {
    text,
    attachments = [],
    ts,
    note = null,
  }: { text: string; attachments?: AttachmentMeta[]; ts?: number; note?: { title: string; taskId: string | null } | null } = $props();

  let expanded = $state(false);
  let bodyEl = $state<HTMLDivElement | null>(null);
  let overflowing = $state(false);
  let copied = $state(false);
  /** Lightbox 打开位（null=关；点击附件 chip 置位——纯图消息同样生效）。 */
  let lightboxIndex = $state<number | null>(null);

  // 溢出检测抗异步渲染（Owner 2026-09-28 二轮：markstream 内容可能晚于
  // 首帧落定）：初始测一次 + ResizeObserver 盯容器与内容根，内容尺寸变化
  // 即复测——「展开全文」只在真被折叠阈值截断时出现。
  $effect(() => {
    void text;
    void expanded;
    const el = bodyEl;
    if (el === null) return;
    const measure = (): void => {
      overflowing = !expanded && el.scrollHeight - el.clientHeight > 4;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild !== null) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  });

  /** copy 反馈（assistant copyText 同模式：成功打勾 1.5s；剪贴板不可用静默）。 */
  async function copyText(): Promise<void> {
    if (text.trim().length === 0) return;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // 剪贴板不可用（非安全上下文）静默——局域网 IP 直访下常见。
    }
  }
</script>

<div class="group/user">
  <!-- 附件 chip 行（2.6.4 回放渲染）：右对齐随气泡；点击开应用内 Lightbox。 -->
  {#if attachments.length > 0}
    <div class="mb-1 flex flex-wrap justify-end gap-1" data-testid="user-attachments">
      {#each attachments as att, i (att.blobRef)}
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 py-0.5 pl-0.5 pr-1.5 transition-colors hover:bg-muted"
          title="{att.name}（{att.width}×{att.height}）——点击查看大图"
          aria-label="查看 {att.name} 大图"
          onclick={() => (lightboxIndex = i)}
          data-testid="user-attachment-chip"
        >
          <img src={agentAssetUrl(att.blobRef)} alt={att.name} class="h-8 w-8 rounded object-cover" onerror={retryRawImageOnError} />
          <span class="max-w-28 truncate text-[10px]">{att.name}</span>
        </button>
      {/each}
    </div>
  {/if}
  {#if text.trim().length > 0}
    <div class="relative">
      <!-- [w17-critic T1] 系统注记角落图标（任务绑定/图片映射——投影层已移出正文）：
           title 悬浮承载注记原文，正文保持用户原话。 -->
      {#if note !== null}
        <span
          class="text-muted-foreground/60 hover:text-muted-foreground absolute top-1 right-1 z-[1] flex size-4 items-center justify-center"
          title={note.title}
          aria-label={note.taskId !== null ? `已绑定任务（${note.taskId}）——悬停查看系统注记` : "系统注记——悬停查看"}
          data-testid="user-msg-note"
        >
          <IconInfo class="size-3" aria-hidden="true" />
        </span>
      {/if}
      <div
        bind:this={bodyEl}
        class="bubble-user px-3.5 py-2 text-[12px] leading-[19px] {expanded ? '' : 'max-h-[114px] overflow-hidden'} {note !== null ? 'pr-7' : ''}"
      >
        <!-- 6 行内完整显示（max-h-[114px]=6 行×19px 行高）；静态文本不走打字机/
             渐显动画路径（Owner 2026-09-28：typewriter 挂载的过渡链在气泡里留下
             幻影高度——内容 19px 根却 600px，「展开全文」误常驻；final 标记终稿语义）。 -->
        <MarkdownRender content={text} final={true} typewriter={false} fade={false} viewportPriority={false} />
      </div>
      {#if expanded}
        <div class="mt-1 flex justify-center">
          <button
            type="button"
            class="flex h-6 items-center gap-1 rounded-full border border-border bg-popover px-2.5 text-[10px] text-muted-foreground shadow-sm transition-colors hover:text-foreground"
            aria-label="收起消息"
            onclick={() => (expanded = false)}
          >
            收起
            <IconChevronUp class="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      {:else if overflowing}
        <!-- 渐变遮罩盖住截断行，按钮压在 bottom-center。 -->
        <div
          class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent"
          aria-hidden="true"
        ></div>
        <div class="absolute inset-x-0 bottom-1.5 flex justify-center">
          <button
            type="button"
            class="flex h-6 items-center gap-1 rounded-full border border-border bg-popover px-2.5 text-[10px] text-muted-foreground shadow-md transition-colors hover:text-foreground"
            aria-label="展开完整消息"
            aria-expanded={expanded}
            onclick={() => (expanded = true)}
          >
            展开全文
            <IconChevronDown class="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      {/if}
    </div>
  {/if}
  <!-- [T3] 用户侧工具条（气泡下方右对齐；assistant 同款 hover 语义）：
       [copy 钮（空文本纯图消息不显）][时间戳（无 ts 不显）]——两者皆空整行不占位。 -->
  {#if text.trim().length > 0 || ts !== undefined}
    <div
      class="mt-0.5 flex h-5 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100"
      role="toolbar"
      aria-label="消息操作"
      data-testid="user-msg-toolbar"
    >
      {#if text.trim().length > 0}
        <button
          type="button"
          class="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          title="复制"
          aria-label="复制消息"
          onclick={() => void copyText()}
          data-testid="user-msg-copy"
        >
          {#if copied}
            <IconCheck class="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          {:else}
            <IconCopy class="h-3.5 w-3.5" aria-hidden="true" />
          {/if}
        </button>
      {/if}
      {#if ts !== undefined}
        <span class="text-muted-foreground px-0.5 text-[10px] tabular-nums" data-testid="user-msg-time">
          {formatMessageTime(ts)}
        </span>
      {/if}
    </div>
  {/if}
  {#if lightboxIndex !== null && attachments.length > 0}
    <Lightbox
      items={attachments}
      index={lightboxIndex}
      onclose={() => (lightboxIndex = null)}
    />
  {/if}
</div>
