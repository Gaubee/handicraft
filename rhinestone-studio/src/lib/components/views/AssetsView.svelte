<!--
Orthogonal intents (max 5):
1. [2026-09-19 Layout] 全出血固定视口骨架：左树 240px（lg+）+ 右区（面包屑/工具行/主滚动/状态条），
   App 壳 flex 链 min-h-0/min-w-0 逐层；主滚动只在网格/列表区。
2. [2026-09-19 Browse] 树（系统目录置顶+徽标/用户目录/树底新建）+ 面包屑 + 网格|列表 + 导航与预览入口；
   [4.3b] gemtpl 卡片两动作（C.5.1 canonical：去使用 = openIntent+切实验室 / 去编辑 = TemplateEditSheet）；
   [4.6] gemgen 卡双击定位动线（C.4/B.2.4：先 parse 成功再置意图+切实验室；悬停 [在实验室查看]）；
   [1.4] 全部素材 type-aware：项目卡（类型图标/徽标/summary 直出）+ 底栏「共 N 项 · 图片 X · 项目 Y」
   （五 kind 聚合不拆分）+ 项目节点统一手势（桌面单击选中——工具行 [打开]/[重命名]、Enter=打开；双击/移动端单击=按格式路由）；
   图片节点手势不动（修订归 4.7）。
3. [2026-09-19 Selection] 多选三入口：工具行「选择」/ 桌面 ⌘Ctrl+点击 / 移动端长按；批量移动/删除/下载；
   gemtpl 选中态 [打开] = 去使用等价物（键盘 Enter 归 4.7 手势统一切片）。
4. [2026-09-19 Trash] 回收站视图：计数徽标 + 清空（红色点名确认 + EmptyTrashResult.skipped 引用保护明细）。
5. [2026-09-19 States] 七态：空库引导/迁移细进度条/blob 缺失徽标/上传三段式 toast/重名后缀/移动环禁用/清空跳过明示。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import * as Sheet from '$lib/components/ui/sheet'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import AssetThumb from '../../../components/Assets/AssetThumb.svelte'
  import AssetsTreeList from '../../../components/Assets/AssetsTreeList.svelte'
  import AssetPreviewOverlay from '../../../components/Assets/AssetPreviewOverlay.svelte'
  import GemshapeSheet from '../../../components/Assets/GemshapeSheet.svelte'
  import MoveDialog from '../../../components/Assets/MoveDialog.svelte'
  import TemplateEditSheet from '../../../components/Assets/TemplateEditSheet.svelte'
  import ConfirmDialog from '../../../components/ConfirmDialog.svelte'
  import * as library from '$lib/assets/library.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import { openTemplateSheet } from '$lib/stores/templateSheet.svelte'
  import {
    ackOpenIntentFailure,
    ackOpenIntentSuccess,
    claimOpenIntent,
    peekOpenIntent,
    setOpenIntent,
  } from '$lib/stores/openIntent.svelte'
  import { setView } from '$lib/stores/view.svelte'
  import {
    SYS_SHAPES_FOLDER_ID,
    ingestGemshapeFile,
    type AssetImage,
    type AssetNode,
    type EmptyTrashResult,
  } from '$lib/persistence/assetStore'
  import { PROJECT_MIME, type AssetProject } from '$lib/persistence/projectTypes'
  import { parseGemgen } from '$lib/persistence/labFile'
  import { parseGemshape } from '$lib/persistence/gemshapeFile'
  import { getImageBlob } from '$lib/persistence/imageStore'
  import ArrowUp from '@lucide/svelte/icons/arrow-up'
  import Brush from '@lucide/svelte/icons/brush'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import DraftingCompass from '@lucide/svelte/icons/drafting-compass'
  import Download from '@lucide/svelte/icons/download'
  import FolderPlus from '@lucide/svelte/icons/folder-plus'
  import House from '@lucide/svelte/icons/house'
  import Images from '@lucide/svelte/icons/images'
  import LayoutGrid from '@lucide/svelte/icons/layout-grid'
  import LayoutTemplate from '@lucide/svelte/icons/layout-template'
  import List from '@lucide/svelte/icons/list'
  import Lock from '@lucide/svelte/icons/lock'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Shapes from '@lucide/svelte/icons/shapes'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import Trash from '@lucide/svelte/icons/trash'
  import Upload from '@lucide/svelte/icons/upload'
  import Check from '@lucide/svelte/icons/check'

  // —— 导航与呈现 ——
  let currentFolder = $state<string | null>(null) // null = 根；'sys-trash' = 回收站视图
  let viewMode = $state<'grid' | 'list'>('grid')

  // —— 多选 ——
  let selectionMode = $state(false)
  let selectedIds = $state<Set<string>>(new Set())

  // —— 覆盖层 ——
  let previewAssetId = $state<string | null>(null)
  let previewOpen = $state(false)
  let moveIds = $state<string[]>([])
  let moveOpen = $state(false)
  let confirmTrashTargets = $state<string[]>([])
  let confirmTrashStats = $state({ images: 0, folders: 0 })
  let confirmEmptyOpen = $state(false)
  let emptyResult = $state<EmptyTrashResult | null>(null)
  let folderSheetOpen = $state(false)

  // —— 上传与定位 ——
  let fileInput = $state<HTMLInputElement | null>(null)
  let highlightId = $state<string | null>(null)
  let highlightTimer: ReturnType<typeof setTimeout> | null = null

  // —— 行内重命名（网格/列表双击发起；Esc 取消、Enter/失焦提交）——
  let renamingId = $state<string | null>(null)
  let renameValue = $state('')

  function startInlineRename(node: AssetNode): void {
    if (library.isSystemFolderNode(node) || node.parentId === 'sys-cases') return
    renamingId = node.id
    renameValue = node.name
  }

  function cancelInlineRename(): void {
    renamingId = null
  }

  async function commitInlineRename(): Promise<void> {
    const id = renamingId
    if (id === null) return
    renamingId = null
    await library.renameOp(id, renameValue)
  }

  onMount(() => {
    // 迁移幂等（readyPromise 缓存）+ 无条件重查：lab 归档等外部写入者不通知本投影，
    // Tabs 惰性挂载下每次进入素材库都必须重新读 IDB（节点量级 <千，全量读廉价）。
    // 重查失败（如测试拆台/IDB 暂不可用）静默保留上次快照，下次挂载重试。
    void library
      .ensureLibraryReady()
      .then(() => library.refresh())
      .catch(() => undefined)
    // [4.4] gemgen 缩略 objectURL 随视图卸载回收（会话内缓存，不入 library LRU）
    return () => {
      for (const url of Object.values(gemgenThumbUrls)) URL.revokeObjectURL(url)
    }
  })

  // —— 派生 ——
  const nodes = $derived(library.getNodes())
  const inTrash = $derived(currentFolder === 'sys-trash')
  const items = $derived(inTrash ? library.trashedNodes() : library.childrenOf(currentFolder))
  const breadcrumb = $derived(library.pathOf(inTrash ? null : currentFolder))
  const currentFolderNode = $derived(library.nodeById(currentFolder))
  const isSystemCurrent = $derived(library.isSystemFolderNode(currentFolderNode))
  const inCases = $derived(currentFolder === 'sys-cases')
  const migrationRunning = $derived(library.isMigrationRunning())
  const emptyLibrary = $derived(library.isLibraryEmpty() && !migrationRunning)
  const ready = $derived(library.isReady())
  const previewNode = $derived(previewAssetId !== null ? library.nodeById(previewAssetId) : null)
  const previewAsset = $derived(previewNode !== null && previewNode.type === 'image' ? previewNode : null)
  const selectedArray = $derived([...selectedIds])
  const selectedImages = $derived(
    selectedArray
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is Extract<AssetNode, { type: 'image' }> => n?.type === 'image'),
  )
  const selectedGemtplIds = $derived(
    selectedArray.filter((id) => {
      const n = nodes.find((x) => x.id === id)
      return n !== undefined && isGemtpl(n)
    }),
  )
  /** [1.4] 单选态项目节点（非多选模式下的唯一选中项——工具行 [打开]/[重命名] 与 Enter=打开 的对象）。 */
  const selectedProjectNode = $derived.by(() => {
    if (selectionMode || selectedArray.length !== 1) return null
    const found = nodes.find((n) => n.id === selectedArray[0])
    return found !== undefined && found.type === 'project' ? found : null
  })
  /** [1.4] 底栏 type-aware 计数拆分（图片/项目五 kind 聚合）。 */
  const statusCounts = $derived(library.visibleItemCounts())

  const SOURCE_LABELS: Record<string, string> = {
    upload: '上传',
    'lab-generate': '生成',
    'edit-export': '导出',
    preset: '案例',
    migrated: '迁移',
  }

  const SYSTEM_ENTRIES: Array<{ id: string | null; label: string; icon: 'all' | 'templates' | 'shapes' | 'generated' | 'uploads' | 'exports' | 'cases' | 'trash'; badge?: 'generated' | 'trash'; lock?: boolean }> = [
    { id: null, label: '全部素材', icon: 'all' },
    // [4.2] sys-templates 插「生成结果」之前（产线邻接：模板 → 生成结果，补充稿 C.1）
    { id: 'sys-templates', label: '模板', icon: 'templates' },
    // [gem-catalog 2.1] sys-shapes「钻形」插「模板」与「生成结果」之间（配置资产聚簇，design §3.2-4）
    { id: 'sys-shapes', label: '钻形', icon: 'shapes' },
    { id: 'sys-generated', label: '生成结果', icon: 'generated', badge: 'generated' },
    { id: 'sys-uploads', label: '上传', icon: 'uploads' },
    { id: 'sys-exports', label: '导出', icon: 'exports' },
    { id: 'sys-cases', label: '案例', icon: 'cases', lock: true },
    { id: 'sys-trash', label: '回收站', icon: 'trash', badge: 'trash' },
  ]

  /** 项目类型标注（卡面副行回退值 / 列表「来源」列）。 */
  const PROJECT_KIND_LABELS: Record<string, string> = {
    gemproj: '排钻项目',
    gemdoc: '精修项目',
    gemtpl: '模板',
    gemgen: '生成结果',
    gemshape: '钻形',
  }

  /** [1.4] 类型徽标短标（卡面右上角；gemgen「生成」/gemshape「钻形」在各自分支内联，此处补三值）。 */
  const PROJECT_BADGE_LABELS: Record<string, string> = {
    gemproj: '排钻',
    gemdoc: '精修',
    gemtpl: '模板',
  }

  /** [1.4] 项目卡 summary 缓存直出一行（缺省字段跳过；全空回退类型标注——gemtpl summary 恒空）。 */
  function projectSummaryLine(node: AssetProject): string {
    if (node.projectKind === 'gemgen') return gemgenSummaryLine(node)
    if (node.projectKind === 'gemshape') return node.summary.size ? `${node.summary.size} · 钻形` : '钻形'
    const parts = [
      node.summary.gemCount !== undefined ? `${node.summary.gemCount} 钻` : undefined,
      node.summary.sourceName,
      node.summary.updatedHint,
    ]
    const line = parts.filter((part): part is string => part !== undefined && part !== '').join(' · ')
    return line !== '' ? line : (PROJECT_KIND_LABELS[node.projectKind] ?? node.projectKind)
  }

  // —— [4.4] gemgen 最小可读渲染（哑卡片升级：thumb 缩略或 Sparkles 占位 + summary 直出）——
  function isGemgen(node: AssetNode): node is AssetProject {
    return node.type === 'project' && node.projectKind === 'gemgen'
  }

  /** summary 缓存直出一行（溯源徽标 templateName 在行首；缺省字段跳过）。 */
  function gemgenSummaryLine(node: AssetProject): string {
    const parts = [
      node.summary.templateName,
      node.summary.candidateIndex !== undefined ? `候选 ${node.summary.candidateIndex + 1}` : undefined,
      node.summary.size,
      node.summary.mode === 'edit' ? '编辑' : undefined,
    ]
    return parts.filter((part): part is string => part !== undefined && part !== '').join(' · ')
  }

  // gemgen 缩略（256px thumb 物理记录）懒解析：objectURL 会话内缓存；已解析/在途 id 非响应式登记防重。
  let gemgenThumbUrls = $state<Record<string, string>>({})
  const resolvedThumbIds = new Set<string>()
  $effect(() => {
    for (const node of items) {
      if (!isGemgen(node) || node.thumbKey === undefined || node.trashedAt !== undefined) continue
      if (resolvedThumbIds.has(node.id)) continue
      resolvedThumbIds.add(node.id)
      const thumbKey = node.thumbKey
      void getImageBlob(thumbKey)
        .then((blob) => {
          if (blob) gemgenThumbUrls[node.id] = URL.createObjectURL(blob)
        })
        .catch(() => undefined) // thumb 物理记录缺失：回落 Sparkles 占位，不报错
    }
  })

  // —— [4.3b] gemtpl 卡片两动作（补充稿 C.5.1：一个动作一个 canonical handler；
  //    任何新入口只许绑这两个，禁止第三条独立路径）——
  function isGemtpl(node: AssetNode): boolean {
    return node.type === 'project' && node.projectKind === 'gemtpl'
  }

  /** 去使用（canonical）：置打开意图 + 切实验室（LabView 七步定位消费与画廊过滤 = 4.6 切片）。 */
  function useGemtpl(assetId: string): void {
    setOpenIntent({ kind: 'gemtpl', assetId })
    setView('lab')
  }

  /** 去编辑（canonical）：素材库 RightSheet 第二宿主（TemplateEditSheet 单例）。 */
  function editGemtpl(assetId: string): void {
    openTemplateSheet(assetId)
  }

  // —— [gem-catalog 2.2] gemshape 钻形资产：查看 RightSheet + 卡片贴图懒解析 + 意图定位 ——
  let gemshapeEditId = $state<string | null>(null)

  function isGemshape(node: AssetNode): boolean {
    return node.type === 'project' && node.projectKind === 'gemshape'
  }

  /** 去编辑（canonical，唯一动作）：打开查看 Sheet（内容不可变——另存副本入口在 Sheet 内）。 */
  function editGemshape(assetId: string): void {
    gemshapeEditId = assetId
  }

  function closeGemshapeSheet(): void {
    gemshapeEditId = null
  }

  async function onGemshapeForked(nodeId: string): Promise<void> {
    await library.refresh()
    const node = library.nodeById(nodeId)
    navigate(node?.parentId ?? SYS_SHAPES_FOLDER_ID)
    flashHighlight(nodeId)
  }

  // 卡片贴图懒解析（文件内 dataUrl，非 objectURL——无需回收；已解析 id 非响应式登记防重）
  let gemshapeTextureUrls = $state<Record<string, string>>({})
  const resolvedShapeTextureIds = new Set<string>()
  $effect(() => {
    for (const entry of items) {
      if (entry.type !== 'project' || entry.projectKind !== 'gemshape' || entry.trashedAt !== undefined) continue
      const node = entry
      if (resolvedShapeTextureIds.has(node.id)) continue
      resolvedShapeTextureIds.add(node.id)
      const blobKey = node.blobKey
      const mime = node.mime
      void getImageBlob(blobKey)
        .then(async (blob) => {
          if (!blob) return null
          try {
            return parseGemshape(await blob.text(), { mime }).texture.dataUrl
          } catch {
            return null // parse 失败：回落 Shapes 占位（missing 态在 Sheet 内可见）
          }
        })
        .then((dataUrl) => {
          if (dataUrl) gemshapeTextureUrls[node.id] = dataUrl
        })
        .catch(() => undefined)
    }
  })

  // [gem-catalog 2.2 / design §3.2-3] gemshape 意图消费：素材库定位（导航至所在目录 + 闪高亮）。
  // claim → 成功 ack；节点不存在 ackFailed（failed 态可诊断驻留）。
  $effect(() => {
    const intent = peekOpenIntent()
    if (intent === null || intent.phase !== 'pending' || intent.kind !== 'gemshape') return
    const claim = claimOpenIntent()
    if (claim === null || claim.kind !== 'gemshape') return
    const node = library.nodeById(claim.assetId)
    if (node === null) {
      ackOpenIntentFailure(claim.token, '钻形资产不存在（可能已被永久删除）')
      showToast('无法定位钻形资产：节点不存在。')
      return
    }
    navigate(node.parentId ?? SYS_SHAPES_FOLDER_ID)
    flashHighlight(claim.assetId)
    ackOpenIntentSuccess(claim.token)
  })

  // —— [4.6] gemgen 卡双击定位动线（补充稿 C.4 + design §9.2 B3：gemgen 主任务 = 定位查看）——
  //    canonical handler：**先 parse 成功再置意图 + 切实验室**（解析先于切视图——失败不离开
  //    素材库、不置意图、三段式 toast）；LabView 侧七步定位-展开消费。
  async function useGemgen(node: AssetProject): Promise<void> {
    try {
      const blob = await getImageBlob(node.blobKey)
      if (blob === null) throw new Error('档案字节缺失（物理记录丢失）')
      parseGemgen(await blob.text(), { mime: node.mime }) // 与画廊投影同一解析口径（kind/mime/版本门交叉校验）
      setOpenIntent({ kind: 'gemgen', assetId: node.id })
      setView('lab')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // 三段式：失败事实（哪个档案）+ 原因 + 恢复动作（留在素材库）
      showToast(`无法打开生成结果「${node.name}」：${reason}。已留在素材库，可尝试还原或重新导入该档案。`)
    }
  }

  // —— [1.4] 项目节点统一打开路由（design §2/§7.4：按格式路由到对应页，一页一格式）——
  //    canonical handler：双击 / 移动端单击 / 选中态工具行 [打开] / Enter 全部收敛于此。
  //    gemproj/gemdoc 经 openIntent 由对应页消费（守卫与解析失败处理在消费侧——EditView 已落，
  //    StudioView 打开链路随 studio-layers 落地）；gemtpl/gemgen 沿 4.6 canonical；gemshape 查看 Sheet。
  //    软删（回收站视图）节点不开。
  function openProjectNode(node: AssetProject): void {
    if (inTrash || node.trashedAt !== undefined) return
    selectedIds = new Set()
    if (node.projectKind === 'gemproj') {
      setOpenIntent({ kind: 'gemproj', assetId: node.id })
      setView('studio')
    } else if (node.projectKind === 'gemdoc') {
      setOpenIntent({ kind: 'gemdoc', assetId: node.id })
      setView('edit')
    } else if (node.projectKind === 'gemtpl') {
      useGemtpl(node.id)
    } else if (node.projectKind === 'gemgen') {
      void useGemgen(node)
    } else {
      editGemshape(node.id)
    }
  }

  // —— 导航 ——
  function navigate(folderId: string | null): void {
    currentFolder = folderId
    selectionMode = false
    selectedIds = new Set()
    folderSheetOpen = false
  }

  function goUp(): void {
    if (inTrash) {
      navigate(null)
      return
    }
    navigate(currentFolderNode?.parentId ?? null)
  }

  // —— 多选 ——
  function toggleSelection(id: string): void {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selectedIds = next
  }

  function exitSelectionMode(): void {
    selectionMode = false
    selectedIds = new Set()
  }

  /** [1.4] 桌面单击选中项目节点（唯一选中；再点同卡取消）。 */
  function togglePlainSelection(id: string): void {
    selectedIds = selectedIds.size === 1 && selectedIds.has(id) ? new Set() : new Set([id])
  }

  function itemClick(node: AssetNode, event: MouseEvent): void {
    if (selectionMode || event.metaKey || event.ctrlKey) {
      toggleSelection(node.id)
      return
    }
    if (node.type === 'folder') navigate(node.id)
    else if (node.type === 'image') openPreview(node.id)
    else if (lastPointerType !== 'mouse') openProjectNode(node) // 移动端单击项目节点 = 打开
    else togglePlainSelection(node.id) // [1.4] 桌面单击项目节点 = 选中（双击打开；图片节点手势 4.7 不动）
  }

  function openPreview(assetId: string): void {
    previewAssetId = assetId
    previewOpen = true
  }

  /** 生成图 → 原图跳转（[Owner] 配对关联；同预览窗内切换） */
  function onOpenReference(asset: AssetImage): void {
    openPreview(asset.id)
  }

  // 移动端长按进入多选
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  let pressPoint = { x: 0, y: 0 }
  // 最近一次指针类型（pointerdown 先于 click）：gemtpl「移动端单击 = 去使用」的判定依据；
  // 无 pointerdown 前置的合成 click（键盘/程序）按桌面语义（不打开）
  let lastPointerType = 'mouse'
  function onPointerDown(node: AssetNode, event: PointerEvent): void {
    lastPointerType = event.pointerType || 'mouse'
    if (event.pointerType === 'mouse') return
    pressPoint = { x: event.clientX, y: event.clientY }
    pressTimer = setTimeout(() => {
      pressTimer = null
      selectionMode = true
      toggleSelection(node.id)
    }, 480)
  }
  function cancelPress(): void {
    if (pressTimer) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
  }
  function onPointerMove(event: PointerEvent): void {
    if (!pressTimer) return
    if (Math.abs(event.clientX - pressPoint.x) > 10 || Math.abs(event.clientY - pressPoint.y) > 10) cancelPress()
  }

  // [1.4] 选中态键盘：Enter = 打开（canonical 路由）；Esc = 取消单选。
  // 覆盖层（预览/移动/删除确认/目录 Sheet）开着时不劫持；行内重命名输入自持 Enter/Esc
  // （stopPropagation）；多选模式键盘导航归 4.7；文本控件内不劫持。
  function onDocumentKeydown(event: KeyboardEvent): void {
    if (
      selectionMode ||
      renamingId !== null ||
      previewOpen ||
      folderSheetOpen ||
      moveOpen ||
      confirmTrashTargets.length > 0 ||
      confirmEmptyOpen ||
      gemshapeEditId !== null
    ) {
      return
    }
    const target = event.target
    if (
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return
    }
    if (event.key === 'Escape' && selectedIds.size > 0) {
      selectedIds = new Set()
      return
    }
    if (event.key === 'Enter' && selectedProjectNode !== null) openProjectNode(selectedProjectNode)
  }

  // —— 工具行动作 ——
  async function handleUploadFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return
    const target = inTrash ? null : currentFolder
    const picked = [...files]
    // [gem-catalog 2.2] .gemshape 钻形资产导入路由（第五格式）：六 gate 全量校验后落 sys-shapes
    // （自定义钻形与内置规格同域——裁决一）；失败三段式 toast、不留半节点（单事务保证）。
    const shapeFiles = picked.filter(
      (file) => file.name.toLowerCase().endsWith('.gemshape') || file.type === PROJECT_MIME.gemshape,
    )
    for (const file of shapeFiles) {
      try {
        const result = await ingestGemshapeFile(file, { parentId: target ?? SYS_SHAPES_FOLDER_ID })
        showToast(`已导入钻形「${result.node.name}」`)
        await library.refresh()
        navigate(result.node.parentId ?? SYS_SHAPES_FOLDER_ID)
        flashHighlight(result.node.id)
      } catch (error) {
        showToast(`导入钻形失败（${file.name}）：${error instanceof Error ? error.message : String(error)}。未入库。`)
      }
    }
    const images = picked.filter((file) => !shapeFiles.includes(file))
    if (images.length === 0) return
    const outcome = await library.uploadFiles(images, target)
    if (outcome.created.length > 0) showToast(`已上传 ${outcome.created.length} 张图片`)
    if (outcome.duplicates.length > 0) {
      showToast(outcome.duplicates.length === 1 ? '这张图已在库中' : `${outcome.duplicates.length} 张图已在库中`)
      navigate(outcome.targetFolderId)
      flashHighlight(outcome.duplicates[outcome.duplicates.length - 1]?.id ?? null)
    } else if (outcome.created.length > 0) {
      navigate(outcome.targetFolderId)
      flashHighlight(outcome.created[outcome.created.length - 1]?.id ?? null)
    }
  }

  function flashHighlight(id: string | null): void {
    highlightId = id
    if (highlightTimer) clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => (highlightId = null), 2200)
  }

  async function handleCreateFolder(): Promise<void> {
    const folder = await library.createFolderOp(inTrash ? null : currentFolder)
    if (folder) {
      flashHighlight(folder.id)
      if (folder.parentId !== currentFolder && !inTrash) navigate(folder.parentId)
    }
  }

  function openMoveSelection(): void {
    if (selectedImages.length === 0 && selectedArray.length === 0) return
    moveIds = [...selectedArray]
    moveOpen = true
  }

  function openTrashConfirm(ids: string[]): void {
    const totals = ids.reduce(
      (acc, id) => {
        const stats = library.subtreeStats(id)
        return { images: acc.images + stats.images, folders: acc.folders + stats.folders }
      },
      { images: 0, folders: 0 },
    )
    confirmTrashStats = totals
    confirmTrashTargets = ids
  }

  async function confirmTrash(): Promise<void> {
    const count = await library.trashOp(confirmTrashTargets)
    if (count > 0) showToast(`已将 ${count} 项移入回收站`)
    confirmTrashTargets = []
    exitSelectionMode()
    if (inTrash) navigate('sys-trash')
  }

  async function confirmEmptyTrash(): Promise<void> {
    const result = await library.emptyTrashOp()
    confirmEmptyOpen = false
    if (!result) return
    if (result.deletedNodeIds.length > 0) showToast(`已永久删除 ${result.deletedNodeIds.length} 项`)
    emptyResult = result.skipped.length > 0 ? result : null
  }

  async function handleDownloadSelection(): Promise<void> {
    const count = await library.downloadOp(selectedImages.map((n) => n.id))
    if (count === 0) showToast('没有可下载的图片（可能已失效）')
  }

  // —— 预览动作上行 ——
  function onPreviewDownload(): void {
    if (previewAsset) void library.downloadOp([previewAsset.id])
  }

  function onPreviewRename(asset: AssetNode, name: string): void {
    void library.renameOp(asset.id, name)
  }

  function onPreviewMove(asset: AssetNode): void {
    moveIds = [asset.id]
    moveOpen = true
  }

  function onPreviewDelete(asset: AssetNode): void {
    openTrashConfirm([asset.id])
  }

  function formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 MB'
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  function formatTime(ts: number): string {
    const d = new Date(ts)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  function skipReasonLabel(reason: string): string {
    if (reason === 'pinned' || reason === 'pinned-descendant') return '正被模块引用'
    return '保留树连通'
  }
</script>

<svelte:document onkeydown={onDocumentKeydown} />

<div class="relative flex h-full min-h-0 min-w-0 overflow-hidden" data-testid="assets-view">
  <!-- 七态② 迁移进行中：顶部细进度条（迁移不阻塞浏览） -->
  {#if migrationRunning}
    <div class="absolute inset-x-0 top-0 z-40" data-testid="migration-progress">
      <div class="bg-primary/20 h-0.5 w-full overflow-hidden">
        <div class="bg-primary h-full w-1/3 animate-pulse"></div>
      </div>
      <p class="text-muted-foreground absolute top-1 right-3 text-[10px]">正在整理既有图片…</p>
    </div>
  {/if}

  <!-- 桌面左树 240px：系统目录置顶分区（徽标）+ 用户目录区 + 树底新建 -->
  <aside class="bg-card hidden w-60 shrink-0 flex-col border-r lg:flex lg:min-h-0" data-testid="assets-tree">
    <div class="min-h-0 flex-1 overflow-y-auto p-2">
      <p class="text-muted-foreground px-1.5 pt-1 pb-1 text-[10px] font-medium tracking-wider">系统目录</p>
      {#each SYSTEM_ENTRIES as entry (entry.label)}
        <button
          type="button"
          data-testid={`tree-sys-${entry.id ?? 'root'}`}
          class="flex h-7 w-full items-center gap-1.5 rounded px-1.5 text-left text-xs transition-colors {currentFolder === entry.id
            ? 'bg-primary/10 text-primary font-medium'
            : 'hover:bg-muted text-foreground'}"
          onclick={() => navigate(entry.id)}
        >
          {#if entry.icon === 'trash'}
            <Trash class="size-3.5 shrink-0" aria-hidden="true" />
          {:else if entry.icon === 'templates'}
            <LayoutTemplate class="size-3.5 shrink-0" aria-hidden="true" />
          {:else if entry.icon === 'shapes'}
            <Shapes class="size-3.5 shrink-0" aria-hidden="true" />
          {:else if entry.icon === 'generated'}
            <Sparkles class="size-3.5 shrink-0" aria-hidden="true" />
          {:else if entry.icon === 'cases'}
            <Lock class="size-3.5 shrink-0" aria-hidden="true" />
          {:else if entry.icon === 'uploads'}
            <Upload class="size-3.5 shrink-0" aria-hidden="true" />
          {:else if entry.icon === 'exports'}
            <Download class="size-3.5 shrink-0" aria-hidden="true" />
          {:else}
            <Images class="size-3.5 shrink-0" aria-hidden="true" />
          {/if}
          <span class="min-w-0 flex-1 truncate">{entry.label}</span>
          {#if entry.badge === 'generated' && library.generatedCount() > 0}
            <Badge variant="secondary" class="px-1.5 text-[10px]" data-testid="generated-count-badge">
              {library.generatedCount()}
            </Badge>
          {/if}
          {#if entry.badge === 'trash' && library.trashCount() > 0}
            <Badge variant="destructive" class="px-1.5 text-[10px]" data-testid="trash-count-badge">
              {library.trashCount()}
            </Badge>
          {/if}
        </button>
      {/each}

      <p class="text-muted-foreground px-1.5 pt-3 pb-1 text-[10px] font-medium tracking-wider">我的文件夹</p>
      <AssetsTreeList currentFolder={currentFolder ?? ''} onselect={navigate} />
    </div>
    <div class="border-t p-2">
      <Button
        variant="ghost"
        size="sm"
        class="w-full justify-start text-xs"
        onclick={() => void handleCreateFolder()}
        disabled={inTrash || isSystemCurrent}
        title={isSystemCurrent ? '系统目录内不能新建文件夹' : undefined}
        data-testid="tree-new-folder"
      >
        <FolderPlus />
        新建文件夹
      </Button>
    </div>
  </aside>

  <!-- 右区：面包屑 + 工具行 + 主滚动 + 状态条 -->
  <section class="flex min-h-0 min-w-0 flex-1 flex-col">
    <!-- 面包屑行（移动端：目录 ▾ Sheet 选择器入口） -->
    <div class="bg-background/80 flex h-10 shrink-0 items-center gap-1 border-b px-3 text-xs backdrop-blur" data-testid="assets-breadcrumb">
      <button type="button" class="lg:hidden" onclick={() => (folderSheetOpen = true)} data-testid="mobile-folder-trigger">
        <span class="flex h-7 items-center gap-1 rounded border px-2 font-medium">
          {inTrash ? '回收站' : (currentFolderNode?.name ?? '全部素材')}
          <ChevronDown class="size-3.5" aria-hidden="true" />
        </span>
      </button>
      <span class="hidden items-center gap-1 lg:flex">
        <button
          type="button"
          class="hover:bg-muted flex h-6 items-center gap-1 rounded px-1.5 font-medium {currentFolder === null && !inTrash
            ? 'text-foreground'
            : 'text-muted-foreground'}"
          onclick={() => navigate(null)}
        >
          <House class="size-3.5" aria-hidden="true" />
          素材库
        </button>
        {#if inTrash}
          <ChevronRight class="text-muted-foreground/60 size-3" aria-hidden="true" />
          <span class="text-destructive font-medium">回收站</span>
        {:else}
          {#each breadcrumb as crumb, index (crumb.id)}
            <ChevronRight class="text-muted-foreground/60 size-3" aria-hidden="true" />
            <button
              type="button"
              class="hover:bg-muted flex h-6 max-w-40 items-center rounded px-1.5 {index === breadcrumb.length - 1
                ? 'text-foreground font-medium'
                : 'text-muted-foreground'}"
              onclick={() => navigate(crumb.id)}
            >
              <span class="truncate">{crumb.name}</span>
            </button>
          {/each}
        {/if}
        {#if currentFolder !== null || inTrash}
          <button
            type="button"
            class="text-muted-foreground hover:bg-muted hover:text-foreground ml-1 flex h-6 items-center gap-1 rounded px-1.5"
            onclick={goUp}
            title="上一级"
          >
            <ArrowUp class="size-3.5" aria-hidden="true" />
          </button>
        {/if}
      </span>
      <span class="text-muted-foreground ml-auto hidden pl-2 text-[11px] lg:block">{items.length} 项</span>
    </div>

    <!-- 工具行 -->
    <div class="bg-background/60 flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-1.5" data-testid="assets-toolbar">
      <input
        bind:this={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,.gemshape"
        multiple
        class="hidden"
        onchange={(e) => {
          void handleUploadFiles(e.currentTarget.files)
          e.currentTarget.value = ''
        }}
      />
      {#if inTrash}
        <Button variant="destructive" size="sm" onclick={() => (confirmEmptyOpen = true)} disabled={library.trashCount() === 0} data-testid="empty-trash-button">
          <Trash />
          清空回收站
        </Button>
      {:else}
        <Button variant="outline" size="sm" onclick={() => fileInput?.click()} data-testid="upload-button">
          <Upload />
          上传
        </Button>
        <Button
          variant="outline"
          size="sm"
          onclick={() => void handleCreateFolder()}
          disabled={isSystemCurrent}
          title={isSystemCurrent ? '系统目录内不能新建文件夹' : undefined}
        >
          <FolderPlus />
          新建文件夹
        </Button>
      {/if}

      <div class="ml-auto flex items-center gap-1.5">
        {#if !inTrash && !inCases}
          {#if selectionMode}
            <span class="text-muted-foreground text-xs" data-testid="selection-count">已选 {selectedArray.length}</span>
            <Button variant="ghost" size="sm" onclick={exitSelectionMode}>完成</Button>
          {:else}
            <Button variant="ghost" size="sm" onclick={() => (selectionMode = true)} data-testid="select-mode-button">
              选择
            </Button>
          {/if}
        {/if}
        {#if !inTrash && selectedProjectNode !== null}
          <!-- [1.4] 项目节点单击选中态工具行：[打开] = canonical 路由（Enter 键盘等价）；
               [重命名]（双击已让位给打开）；打开前清空选中 -->
          <Button
            variant="outline"
            size="sm"
            onclick={() => openProjectNode(selectedProjectNode)}
            data-testid="open-selected"
          >
            打开
          </Button>
          <Button
            variant="outline"
            size="sm"
            onclick={() => startInlineRename(selectedProjectNode)}
            data-testid="rename-selected"
          >
            重命名
          </Button>
        {/if}
        {#if !inTrash && selectedArray.length > 0}
          {#if selectedGemtplIds.length > 0 && (selectionMode || selectedArray.length > 1)}
            <!-- [4.3b] 选中态工具行 [打开] = gemtpl「去使用」的双击等价物（多选态入口）；
                 选中多条时打开首条（openIntent 单值 replace 语义，C.4）；单选态由 1.4 open-selected 承接 -->
            <Button
              variant="outline"
              size="sm"
              onclick={() => {
                useGemtpl(selectedGemtplIds[0])
                exitSelectionMode()
              }}
              data-testid="batch-open"
            >
              打开
            </Button>
          {/if}
          <Button variant="outline" size="sm" onclick={openMoveSelection} data-testid="batch-move">
            移动到…
          </Button>
          <Button variant="destructive" size="sm" onclick={() => openTrashConfirm(selectedArray)} data-testid="batch-delete">
            删除
          </Button>
          <Button
            variant="outline"
            size="sm"
            onclick={() => void handleDownloadSelection()}
            disabled={selectedImages.length === 0}
            data-testid="batch-download"
          >
            <Download />
            下载
          </Button>
        {/if}
        <div class="bg-border mx-1 hidden h-5 w-px sm:block" aria-hidden="true"></div>
        <div class="bg-muted flex items-center rounded-md border p-0.5">
          <button
            type="button"
            class="flex h-6 w-7 items-center justify-center rounded {viewMode === 'grid' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground'}"
            onclick={() => (viewMode = 'grid')}
            title="网格视图"
            data-testid="view-grid"
            aria-pressed={viewMode === 'grid'}
          >
            <LayoutGrid class="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="flex h-6 w-7 items-center justify-center rounded {viewMode === 'list' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground'}"
            onclick={() => (viewMode = 'list')}
            title="列表视图"
            data-testid="view-list"
            aria-pressed={viewMode === 'list'}
          >
            <List class="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>

    <!-- 主滚动区：网格/列表（唯一滚动位）
         [gem-catalog 2.1] 空库引导卡只在「全部素材」根级出现——内置目录（模板/钻形 seed）
         内容不算用户内容（library.isLibraryEmpty 口径），但目录内浏览不因库空被引导卡盖住 -->
    <div class="bg-muted/30 min-h-0 flex-1 overflow-y-auto p-3" data-testid="assets-content">
      {#if emptyLibrary && !inTrash && currentFolder === null}
        <!-- 七态① 空库引导卡 -->
        <div class="flex h-full flex-col items-center justify-center gap-3 py-16 text-center" data-testid="assets-empty">
          <Images class="text-muted-foreground/40 size-10" aria-hidden="true" />
          <div class="grid gap-1">
            <p class="text-sm font-medium">素材库还是空的</p>
            <p class="text-muted-foreground text-xs">上传图片建立你的素材库；实验室生成的图会自动归档到此处。</p>
          </div>
          <Button size="sm" onclick={() => fileInput?.click()} data-testid="empty-upload-button">
            <Upload />
            上传图片
          </Button>
        </div>
      {:else if !ready && nodes.length === 0}
        <div class="text-muted-foreground flex h-full items-center justify-center text-xs">正在读取素材库…</div>
      {:else if items.length === 0}
        <div class="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 py-16 text-xs" data-testid="folder-empty">
          <span>{inTrash ? '回收站是空的' : '此目录为空'}</span>
          {#if !inTrash}
            <span class="text-muted-foreground/70">上传图片或新建文件夹开始整理</span>
          {/if}
        </div>
      {:else if viewMode === 'grid'}
        <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6" data-testid="assets-grid">
          {#each items as node (node.id)}
            {@const selected = selectedIds.has(node.id)}
            {@const missing = node.type === 'image' && library.getUrl(node.id) === null}
            <button
              type="button"
              data-testid={`asset-item-${node.id}`}
              data-highlight={highlightId === node.id ? 'true' : undefined}
              class="group text-left transition-all {highlightId === node.id ? 'animate-pulse' : ''}"
              onclick={(e) => itemClick(node, e)}
              ondblclick={(e) => {
                if (!selectionMode) {
                  e.preventDefault()
                  // [1.4] 项目节点双击 = 打开（canonical 按格式路由：gemproj/gemdoc 置意图切对应页，
                  // gemtpl/gemgen 沿 4.6 canonical，gemshape 查看 Sheet）；文件夹/图片沿行内重命名
                  // （图片「双击=打开」修订归 4.7）
                  if (node.type === 'project') openProjectNode(node)
                  else startInlineRename(node)
                }
              }}
              onpointerdown={(e) => onPointerDown(node, e)}
              onpointerup={cancelPress}
              onpointerleave={cancelPress}
              onpointercancel={cancelPress}
              onpointermove={onPointerMove}
            >
              <span
                class="relative block aspect-square overflow-hidden rounded-lg border bg-card {selected
                  ? 'border-primary ring-primary/40 ring-2'
                  : 'group-hover:border-ring'} {node.type === 'folder' ? 'flex items-center justify-center' : ''}"
              >
                {#if node.type === 'folder'}
                  <span class="flex size-full flex-col items-center justify-center gap-1">
                    <span class="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
                      <Images class="size-5" aria-hidden="true" />
                    </span>
                    <span class="text-muted-foreground text-[10px]">{library.childrenOf(node.id).length} 项</span>
                  </span>
                {:else if node.type === 'image'}
                  <AssetThumb asset={node} objectFit="object-cover" />
                {:else if node.type === 'project' && node.projectKind === 'gemgen'}
                  <!-- [4.4] gemgen 最小可读渲染：thumb 缩略（256px 物理记录）或 Sparkles 占位 -->
                  {#if gemgenThumbUrls[node.id]}
                    <img
                      src={gemgenThumbUrls[node.id]}
                      alt={node.name}
                      class="size-full object-cover"
                      draggable="false"
                      loading="lazy"
                      data-testid={`gemgen-thumb-${node.id}`}
                    />
                  {:else}
                    <span class="flex size-full items-center justify-center">
                      <span class="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
                        <Sparkles class="size-5" aria-hidden="true" />
                      </span>
                    </span>
                  {/if}
                  <!-- 类型徽标「生成」（与旧图片卡片区分；旧图不动） -->
                  <span
                    class="absolute top-1.5 right-1.5 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white"
                    data-testid={`gemgen-badge-${node.id}`}
                  >
                    生成
                  </span>
                {:else if node.type === 'project' && node.projectKind === 'gemshape'}
                  <!-- [gem-catalog 2.2] 钻形卡：文件内贴图 dataUrl 懒解析（真实剪影）或 Shapes 占位 -->
                  {#if gemshapeTextureUrls[node.id]}
                    <img
                      src={gemshapeTextureUrls[node.id]}
                      alt={node.name}
                      class="size-full object-contain p-3"
                      draggable="false"
                      loading="lazy"
                      data-testid={`gemshape-texture-${node.id}`}
                    />
                  {:else}
                    <span class="flex size-full items-center justify-center">
                      <span class="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
                        <Shapes class="size-5" aria-hidden="true" />
                      </span>
                    </span>
                  {/if}
                  <span
                    class="absolute top-1.5 right-1.5 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white"
                    data-testid={`gemshape-badge-${node.id}`}
                  >
                    钻形
                  </span>
                {:else if node.type === 'project'}
                  <!-- [1.4] 项目卡 type-aware：类型图标（gemproj 制图圆规 / gemdoc 画笔 / gemtpl 版式模板）
                       + 类型徽标；summary 直出在卡面副行（projectSummaryLine） -->
                  <span class="flex size-full items-center justify-center">
                    <span class="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
                      {#if node.projectKind === 'gemproj'}
                        <DraftingCompass class="size-5" aria-hidden="true" />
                      {:else if node.projectKind === 'gemdoc'}
                        <Brush class="size-5" aria-hidden="true" />
                      {:else}
                        <LayoutTemplate class="size-5" aria-hidden="true" />
                      {/if}
                    </span>
                  </span>
                  <span
                    class="absolute top-1.5 right-1.5 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white"
                    data-testid={`project-badge-${node.id}`}
                  >
                    {PROJECT_BADGE_LABELS[node.projectKind] ?? node.projectKind}
                  </span>
                {/if}
                {#if isGemtpl(node)}
                  <!-- [4.3b] 桌面悬停浮层（去使用/去编辑可见性入口；触摸无 hover，pointer-events 仅 hover 时开启，不挡移动端单击=去使用）。
                       span+role=button 而非 button：卡面本身是 button（HTML 禁嵌套交互元素），沿仓内既有先例（行内重命名 input/勾选圈） -->
                  <span
                    class="pointer-events-none absolute inset-0 z-10 hidden items-center justify-center gap-1.5 bg-background/70 opacity-0 backdrop-blur-[1px] transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 sm:flex"
                    data-testid={`gemtpl-overlay-${node.id}`}
                  >
                    <span
                      role="button"
                      tabindex={-1}
                      class="bg-primary text-primary-foreground flex h-7 cursor-pointer items-center rounded-md px-2.5 text-xs font-medium"
                      onclick={(e) => {
                        e.stopPropagation()
                        useGemtpl(node.id)
                      }}
                      onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation()
                          e.preventDefault()
                          useGemtpl(node.id)
                        }
                      }}
                      data-testid={`gemtpl-use-${node.id}`}
                    >
                      去使用
                    </span>
                    <span
                      role="button"
                      tabindex={-1}
                      class="bg-background text-foreground flex h-7 cursor-pointer items-center rounded-md border px-2.5 text-xs"
                      onclick={(e) => {
                        e.stopPropagation()
                        editGemtpl(node.id)
                      }}
                      onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation()
                          e.preventDefault()
                          editGemtpl(node.id)
                        }
                      }}
                      data-testid={`gemtpl-edit-${node.id}`}
                    >
                      去编辑
                    </span>
                  </span>
                  <!-- [4.3b] 移动端卡面右上常驻 ✎（去编辑；桌面 sm+ 隐藏走悬停浮层，C.5.5） -->
                  <span
                    role="button"
                    tabindex={-1}
                    class="bg-background/85 absolute top-1.5 right-1.5 z-10 flex size-7 cursor-pointer items-center justify-center rounded-full border sm:hidden"
                    aria-label="去编辑"
                    title="去编辑"
                    onclick={(e) => {
                      e.stopPropagation()
                      editGemtpl(node.id)
                    }}
                    onkeydown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation()
                        e.preventDefault()
                        editGemtpl(node.id)
                      }
                    }}
                    data-testid={`gemtpl-edit-fab-${node.id}`}
                  >
                    <Pencil class="size-3.5" aria-hidden="true" />
                  </span>
                {/if}
                {#if isGemgen(node)}
                  <!-- [4.6] gemgen 悬停浮层（对齐去使用浮层样式；gemgen 主任务 = 定位查看，
                       无去编辑入口——gemgen 不可变档案）。触摸无 hover：移动端单击 = 打开 -->
                  <span
                    class="pointer-events-none absolute inset-0 z-10 hidden items-center justify-center gap-1.5 bg-background/70 opacity-0 backdrop-blur-[1px] transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 sm:flex"
                    data-testid={`gemgen-overlay-${node.id}`}
                  >
                    <span
                      role="button"
                      tabindex={-1}
                      class="bg-primary text-primary-foreground flex h-7 cursor-pointer items-center rounded-md px-2.5 text-xs font-medium"
                      onclick={(e) => {
                        e.stopPropagation()
                        void useGemgen(node)
                      }}
                      onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation()
                          e.preventDefault()
                          void useGemgen(node)
                        }
                      }}
                      data-testid={`gemgen-use-${node.id}`}
                    >
                      在实验室查看
                    </span>
                  </span>
                {/if}
                {#if isGemshape(node)}
                  <!-- [gem-catalog 2.2] gemshape 悬停浮层（唯一 canonical 动作 = 去编辑：查看 Sheet +
                       另存副本入口——「去使用」归 expert change 钻形库 UI）。触摸无 hover：移动端单击 = 去编辑 -->
                  <span
                    class="pointer-events-none absolute inset-0 z-10 hidden items-center justify-center gap-1.5 bg-background/70 opacity-0 backdrop-blur-[1px] transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 sm:flex"
                    data-testid={`gemshape-overlay-${node.id}`}
                  >
                    <span
                      role="button"
                      tabindex={-1}
                      class="bg-primary text-primary-foreground flex h-7 cursor-pointer items-center rounded-md px-2.5 text-xs font-medium"
                      onclick={(e) => {
                        e.stopPropagation()
                        editGemshape(node.id)
                      }}
                      onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation()
                          e.preventDefault()
                          editGemshape(node.id)
                        }
                      }}
                      data-testid={`gemshape-edit-${node.id}`}
                    >
                      去编辑
                    </span>
                  </span>
                  <!-- 移动端卡面右上常驻 ✎（去编辑；桌面 sm+ 隐藏走悬停浮层，沿 gemtpl 先例） -->
                  <span
                    role="button"
                    tabindex={-1}
                    class="bg-background/85 absolute top-1.5 right-1.5 z-10 flex size-7 cursor-pointer items-center justify-center rounded-full border sm:hidden"
                    aria-label="去编辑"
                    title="去编辑"
                    onclick={(e) => {
                      e.stopPropagation()
                      editGemshape(node.id)
                    }}
                    onkeydown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation()
                        e.preventDefault()
                        editGemshape(node.id)
                      }
                    }}
                    data-testid={`gemshape-edit-fab-${node.id}`}
                  >
                    <Pencil class="size-3.5" aria-hidden="true" />
                  </span>
                {/if}
                {#if selectionMode || selected}
                  <span
                    class="absolute top-1.5 left-1.5 flex size-4 items-center justify-center rounded-full border {selected
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'bg-background/80 border-border'}"
                    data-testid={`asset-check-${node.id}`}
                  >
                    {#if selected}<Check class="size-3" aria-hidden="true" />{/if}
                  </span>
                {/if}
                {#if missing}
                  <span class="absolute right-1.5 bottom-1.5 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white">已失效</span>
                {/if}
              </span>
              {#if renamingId === node.id}
                <input
                  data-testid="inline-rename-input"
                  bind:value={renameValue}
                  class="bg-background mt-1 h-6 w-full rounded border px-1 text-xs"
                  onclick={(e) => e.stopPropagation()}
                  ondblclick={(e) => e.stopPropagation()}
                  onkeydown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') void commitInlineRename()
                    if (e.key === 'Escape') cancelInlineRename()
                  }}
                  onblur={() => void commitInlineRename()}
                />
              {:else}
                <span class="mt-1 block truncate text-xs font-medium" title={node.name}>{node.name}</span>
              {/if}
              <span class="text-muted-foreground block truncate text-[10px]">
                {#if node.type === 'image'}
                  {node.width > 0 ? `${node.width}×${node.height}` : '尺寸未知'} · {SOURCE_LABELS[node.source] ?? node.source}
                {:else if node.type === 'project'}
                  <!-- [1.4] summary 缓存直出（gemgen 溯源/钻形尺寸/工程钻数·来源名；全空回退类型标注） -->
                  {projectSummaryLine(node)}
                {:else}
                  文件夹
                {/if}
              </span>
            </button>
          {/each}
        </div>
      {:else}
        <!-- 列表视图：名称/尺寸/来源/时间 -->
        <div class="bg-card overflow-hidden rounded-lg border" data-testid="assets-list">
          <div class="text-muted-foreground grid grid-cols-[minmax(0,1fr)_70px_56px_90px] gap-2 border-b px-3 py-1.5 text-[11px] font-medium">
            <span>名称</span>
            <span class="text-right">尺寸</span>
            <span class="text-right">来源</span>
            <span class="text-right">时间</span>
          </div>
          {#each items as node (node.id)}
            {@const selected = selectedIds.has(node.id)}
            <button
              type="button"
              data-testid={`asset-row-${node.id}`}
              class="grid w-full grid-cols-[minmax(0,1fr)_70px_56px_90px] items-center gap-2 border-b px-3 py-1.5 text-left text-xs transition-colors last:border-b-0 {selected
                ? 'bg-primary/10'
                : 'hover:bg-muted/60'}"
              onclick={(e) => itemClick(node, e)}
              ondblclick={(e) => {
                if (!selectionMode) {
                  e.preventDefault()
                  // [1.4] 项目节点双击 = 打开（与网格卡同一手势语义，canonical 路由）；
                  // 文件夹/图片沿行内重命名（图片修订归 4.7）
                  if (node.type === 'project') openProjectNode(node)
                  else startInlineRename(node)
                }
              }}
              onpointerdown={(e) => onPointerDown(node, e)}
              onpointerup={cancelPress}
              onpointerleave={cancelPress}
              onpointercancel={cancelPress}
              onpointermove={onPointerMove}
            >
              <span class="flex min-w-0 items-center gap-2">
                <!-- [UX-A] 列表缩略位统一 flex 居中（原 m-1 像素偏移只对 size-6/size-4 组合成立，尺寸一变即漂移） -->
                <span class="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded border">
                  {#if node.type === 'image'}
                    <AssetThumb asset={node} />
                  {:else if node.type === 'project' && node.projectKind === 'gemgen'}
                    <span class="bg-primary/10 text-primary flex size-full items-center justify-center" title={gemgenSummaryLine(node)}>
                      <Sparkles class="size-4" aria-hidden="true" />
                    </span>
                  {:else if node.type === 'project' && node.projectKind === 'gemshape'}
                    <span class="bg-primary/10 text-primary flex size-full items-center justify-center" title="钻形">
                      <Shapes class="size-4" aria-hidden="true" />
                    </span>
                  {:else if node.type === 'project' && node.projectKind === 'gemproj'}
                    <DraftingCompass class="text-primary/60 size-4" aria-hidden="true" />
                  {:else if node.type === 'project' && node.projectKind === 'gemdoc'}
                    <Brush class="text-primary/60 size-4" aria-hidden="true" />
                  {:else if node.type === 'project'}
                    <LayoutTemplate class="text-primary/60 size-4" aria-hidden="true" />
                  {:else}<Images class="text-primary/60 size-4" aria-hidden="true" />{/if}
                </span>
                {#if renamingId === node.id}
                  <input
                    data-testid="inline-rename-input"
                    bind:value={renameValue}
                    class="bg-background h-6 min-w-0 flex-1 rounded border px-1 text-xs"
                    onclick={(e) => e.stopPropagation()}
                    ondblclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') void commitInlineRename()
                      if (e.key === 'Escape') cancelInlineRename()
                    }}
                    onblur={() => void commitInlineRename()}
                  />
                {:else}
                  <span class="truncate font-medium" title={node.name}>{node.name}</span>
                {/if}
              </span>
              <span class="text-muted-foreground text-right tabular-nums">
                {#if node.type === 'image'}{node.width > 0 ? `${node.width}×${node.height}` : '—'}{:else if node.type === 'project'}—{:else}文件夹{/if}
              </span>
              <span class="text-muted-foreground text-right">
                {#if node.type === 'image'}{SOURCE_LABELS[node.source] ?? node.source}{:else if node.type === 'project'}{PROJECT_KIND_LABELS[node.projectKind] ?? node.projectKind}{:else}—{/if}
              </span>
              <span class="text-muted-foreground text-right tabular-nums">{formatTime(node.updatedAt)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- 底部状态条：[1.4] 全部素材口径 type-aware —— 共 N 项（用户文件夹+图片+项目）· 图片 X ·
         项目 Y（AssetProject 五 kind 聚合不拆分，design §2/§7.4）· 回收站 N · 存储 X -->
    <footer class="bg-background text-muted-foreground flex h-8 shrink-0 items-center gap-3 border-t px-3 text-[11px] tabular-nums" data-testid="assets-statusbar">
      <span data-testid="statusbar-total">共 {library.visibleItemCount()} 项</span>
      <span>·</span>
      <span data-testid="statusbar-images">图片 {statusCounts.images}</span>
      <span>·</span>
      <span data-testid="statusbar-projects">项目 {statusCounts.projects}</span>
      <span>·</span>
      <span>回收站 {library.trashCount()} 项</span>
      <span>·</span>
      <span>存储 {formatBytes(library.storageBytes())}</span>
    </footer>
  </section>
</div>

<!-- 预览（桌面 Dialog / 移动全屏 Sheet） -->
<AssetPreviewOverlay
  bind:open={previewOpen}
  asset={previewAsset}
  ondownload={() => onPreviewDownload()}
  onrename={onPreviewRename}
  onmove={onPreviewMove}
  ondelete={onPreviewDelete}
  onOpenReference={onOpenReference}
/>

<!-- 移动端「目录 ▾」Sheet -->
<Sheet.Root bind:open={folderSheetOpen}>
  <Sheet.Content side="bottom" class="max-h-[70vh] overflow-y-auto pb-[env(safe-area-inset-bottom)]" data-testid="mobile-folder-sheet">
    <Sheet.Header class="pb-2">
      <Sheet.Title class="text-sm">选择目录</Sheet.Title>
    </Sheet.Header>
    <div class="grid gap-1 px-4 pb-4">
      {#each SYSTEM_ENTRIES as entry (entry.label)}
        <button
          type="button"
          class="hover:bg-muted flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm {currentFolder === entry.id
            ? 'bg-primary/10 text-primary font-medium'
            : ''}"
          onclick={() => navigate(entry.id)}
        >
          {entry.label}
          {#if entry.badge === 'trash' && library.trashCount() > 0}
            <Badge variant="destructive" class="ml-auto px-1.5 text-[10px]">{library.trashCount()}</Badge>
          {/if}
        </button>
      {/each}
      <p class="text-muted-foreground pt-2 text-[10px] font-medium">我的文件夹</p>
      <AssetsTreeList currentFolder={currentFolder ?? ''} onselect={navigate} />
      <Button variant="outline" size="sm" class="mt-2 w-full" onclick={() => void handleCreateFolder()} disabled={isSystemCurrent}>
        <FolderPlus />
        新建文件夹
      </Button>
    </div>
  </Sheet.Content>
</Sheet.Root>

<!-- 移动到… -->
<MoveDialog bind:open={moveOpen} bind:ids={moveIds} ondone={exitSelectionMode} />

<!-- [4.3b] gemtpl 编辑 RightSheet 单例（openTemplateSheet 全局口驱动；关闭状态机在组件内） -->
<TemplateEditSheet />

<!-- [gem-catalog 2.2] gemshape 查看 RightSheet（本地单值开合——去编辑 canonical 动作驱动）；
     [UX-B] ondeleted = Sheet 内删除确认落库后的投影刷新缝 -->
<GemshapeSheet
  assetId={gemshapeEditId}
  onclose={closeGemshapeSheet}
  onforked={(nodeId) => void onGemshapeForked(nodeId)}
  ondeleted={() => void library.refresh()}
/>

<!-- 删除确认：列明 N 图 M 夹（[UX-B] 收敛到 ConfirmDialog 公共件） -->
<ConfirmDialog
  open={confirmTrashTargets.length > 0}
  title="移入回收站"
  description={`将删除 ${confirmTrashStats.images} 张图片、${confirmTrashStats.folders} 个文件夹（含其全部内容），移入回收站后可从回收站清空。`}
  confirmLabel="移入回收站"
  confirmTestId="confirm-trash"
  onconfirm={() => void confirmTrash()}
  oncancel={() => (confirmTrashTargets = [])}
/>

<!-- 清空回收站：红色点名确认（[UX-B] 收敛到 ConfirmDialog 公共件） -->
<ConfirmDialog
  bind:open={confirmEmptyOpen}
  title={`清空回收站（永久删除 ${library.trashCount()} 项）`}
  description="永久删除不可撤销；正被变体/工作台/编辑引用的图片会被保留并在完成后列明。"
  confirmLabel="永久删除"
  confirmTestId="confirm-empty-trash"
  onconfirm={() => void confirmEmptyTrash()}
/>

<!-- 清空结果：引用保护跳过明细 -->
<Dialog.Root
  open={emptyResult !== null}
  onOpenChange={(next) => {
    if (!next) emptyResult = null
  }}
>
  <Dialog.Content class="max-w-sm">
    <Dialog.Header>
      <Dialog.Title>部分图片已保留</Dialog.Title>
      <Dialog.Description>以下 {emptyResult?.skipped.length ?? 0} 项正被引用或需维持目录结构，未被删除：</Dialog.Description>
    </Dialog.Header>
    <ul class="max-h-48 overflow-y-auto rounded-lg border p-2 text-xs" data-testid="empty-trash-skipped">
      {#each emptyResult?.skipped ?? [] as skip (skip.id)}
        <li class="flex items-center justify-between gap-2 border-b py-1 last:border-b-0">
          <span class="min-w-0 truncate" title={skip.name}>{skip.name}</span>
          <Badge variant="secondary" class="shrink-0 text-[10px]">{skipReasonLabel(skip.reason)}</Badge>
        </li>
      {/each}
    </ul>
    <Dialog.Footer>
      <Button size="sm" onclick={() => (emptyResult = null)}>知道了</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
