<!--
  /login 登录页（split-admin-portal 1.5，2026-09-28；zhumo webui LoginPage.svelte
  形态复刻适配）。居中卡片：品牌+用户名+口令+登录按钮+错误提示+匿名进入
  （allowAnonymous 开时）。登录成功回跳来处（守卫卡 stashReturnTo 的 #/admin/*
  等；无记录回默认首页 #/）。
  正交意图：[1] 用户名+密码登录表单（错误中文）；[2] 匿名进入次入口（可选）。
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { consumeReturnTo, navigate } from '$lib/router.svelte'
  import {
    getAllowAnonymous,
    getSessionError,
    getSiteBrandName,
    login,
    loginAnonymous,
  } from '$lib/stores/session.svelte'

  let username = $state('')
  let password = $state('')
  let busy = $state(false)

  const allowAnonymous = $derived(getAllowAnonymous() === true)
  const error = $derived(getSessionError())
  /** [P2-2] 站点品牌名（后台设置 site_name——未设置回落「贴钻工作台」）。 */
  const brandName = $derived(getSiteBrandName())

  async function submit(): Promise<void> {
    if (busy) return
    busy = true
    const ok = await login(username.trim(), password)
    busy = false
    // 回跳来处（守卫卡 stash 的 #/admin/* 等；无记录回默认首页）。
    if (ok) navigate(consumeReturnTo())
  }

  async function enterAnonymously(): Promise<void> {
    if (busy) return
    busy = true
    const ok = await loginAnonymous()
    busy = false
    if (ok) navigate(consumeReturnTo())
  }
</script>

<div class="bg-background flex min-h-screen items-center justify-center px-4">
  <Dialog.Root open={true}>
    <Dialog.Content class="max-w-sm p-6" data-testid="login-card">
      <Dialog.Header class="gap-1">
        <Dialog.Title class="flex items-center gap-2 text-base">
          <!-- [T5] 品牌位与顶栏同步：logo 图（B2 高清）替换 Bot 图标。 -->
          <img src="/icons/logo-full.png" class="size-6 shrink-0 rounded-md" alt="" />
          登录{brandName}
        </Dialog.Title>
        <Dialog.Description class="text-xs">使用管理员或成员账号继续</Dialog.Description>
      </Dialog.Header>
      <form
        class="mt-2 flex flex-col gap-3"
        onsubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">用户名</span>
          <Input bind:value={username} autocomplete="username" data-testid="login-username" />
        </label>
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">密码</span>
          <Input bind:value={password} type="password" autocomplete="current-password" data-testid="login-password" />
        </label>
        {#if error}
          <p class="text-destructive text-xs" role="alert" data-testid="login-error">{error}</p>
        {/if}
        <Button type="submit" disabled={busy} data-testid="login-submit">
          {busy ? '登录中…' : '登录'}
        </Button>
        {#if allowAnonymous}
          <Button type="button" variant="ghost" disabled={busy} onclick={() => void enterAnonymously()} data-testid="login-anonymous">
            匿名进入
          </Button>
        {/if}
      </form>
    </Dialog.Content>
  </Dialog.Root>
</div>
