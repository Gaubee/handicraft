/*
 * Agent API façade 类型层（design §2 RPC 行 / §3.5 冻结契约——W3.1）。
 * 类型全部自 @handicraft/contracts zod 推导（前后端唯一真源）；façade 的每个
 * 读面输出在实现侧过对应 schema parse（type-safe 即 runtime-safe）。
 * 双实现：MockAgentApi（固定 fixture 帧序列——W4 接线前 UI 开发真源）与
 * RpcAgentApi（@orpc/client RPCLink over /ws/rpc + /ws/tasks/:id 帧流）。
 */

import type {
  Frame,
  LayerDeleteInput,
  LayerDeleteOutput,
  LayerMaskPatchInput,
  LayerMaskPatchOutput,
  LayerReorderInput,
  LayerReorderOutput,
  LayerRenameInput,
  LayerRenameOutput,
  LayerSplitInput,
  LayerStrategySetInput,
  LayerStrategySetOutput,
  MaskEditDiscardInput,
  MaskEditDiscardOutput,
  MaskEditRetryInput,
  MaskEditRetryOutput,
  SegmentOneOutput,
  SessionListInput,
  SessionListOutput,
  SessionSummary,
  TaskArtifactInput,
  TaskArtifactOutput,
  TaskDetailResponse,
  TaskExportInput,
  TaskExportOutput,
  TaskStatus,
  TreeHistoryInput,
  TreeHistoryOutput,
  TreeRevertInput,
  TreeRevertOutput,
  ViewStateSetInput,
  ViewStateSetOutput,
} from '@handicraft/contracts'
import type { AttachmentMeta } from './attachments.js'

/** façade 连接态（mock=本地恒可用；rpc=WS 生命周期）。 */
export type AgentConnectionState = 'mock' | 'connecting' | 'open' | 'closed' | 'error'

/** 会话任务投影（契约 SessionTaskSummary 同形）。 */
export interface AgentTaskView {
  taskId: string
  status: TaskStatus
  lastSeq: number
  frameCount: number
}

/**
 * 集合候选摘要（add-task-stones-manifest-export 1.2——Composer 集合选择器数据面）。
 * sets.list（同 /ws/rpc 路由）摘要投影：字段=warehouse SetSummary 子集，服务端
 * 展开快照只需 resourceId（followup sourceSetId 线字段——W0 冻结契约）。
 */
export interface AgentSetSummary {
  resourceId: string
  setId: string
  name: string
  memberCount: number
  updatedAt: string
  /**
   * 归属组（product-polish-w1 T3——Composer 选择器分组）：mine=当前用户本人组合
   * （置顶组）；market=材料市场组合（admin 所建只读快照——发送首条消息时前端先
   * copyMarketSet 复制为本人副本再绑定 sourceSetId）。缺省视为 mine（旧 daemon
   * /fixture 兼容）。
   */
  scope?: 'mine' | 'market'
}

/** 结果视图（契约 session.result / task.result 的 found 分支同形）。 */
export interface AgentResultView {
  resultId: string
  taskId: string
  publicId?: string
  bundle: { svg: string; bom: string; png: string }
}

export type AgentSessionView = SessionSummary

export interface AgentApi {
  /** 传输模式（mock 固定 fixture / rpc 服务端同源）。 */
  readonly mode: 'mock' | 'rpc'
  /** 当前连接态 + 订阅面（UI 状态条消费）。 */
  connection(): AgentConnectionState
  onConnectionChange(listener: (state: AgentConnectionState) => void): () => void

  listSessions(input?: SessionListInput): Promise<SessionListOutput>
  createSession(input: { title?: string; titlePinned?: boolean }): Promise<{ sessionId: string; createdAt: string }>
  getSession(sessionId: string): Promise<{ session: AgentSessionView; tasks: AgentTaskView[] }>
  /**
   * 一次 followup = 一个 type=agent 的 task；帧经 subscribeTask 流入。
   * 投递通道（add-agent-three-channel 2.1，对齐 shufa b6cec8a followup(mode)）：
   * followup=常规发送（缺省——开新 task）；steer=引导——会话内有运行中 agent 任务时
   * 消息投进该任务（同 taskId 返回，下一 step 边界消费），idle 时等价 followup。
   * [split-admin-portal 2.6.3] attachments：图片附件 blobRef 组（契约「text 或
   * attachments 至少其一」——纯图消息=空文本+有附件；steer+附件由服务端 typed 拒）。
   * [add-task-stones-manifest-export 1.2] sourceSetId：项目集合选择（生产组合
   * resourceId）——**仅会话首个常规 followup 有效**（W0 契约 0.3 冻结：服务端展开
   * 为 stones-manifest 快照；后续轮次携带/steer 携带均 typed 拒）；跳过（缺省）=
   * 空 manifest。错误经 storeError 既有呈现面。
   * [product-polish-w1 T2] autoApprove：会话级自动批准开关透传（与 sourceSetId 同为
   * 会话级参数，但每条 followup 均可携带——最后写入者胜，服务端 sessions 表持久化
   * 刷新/重开保持；开启后新 proposal 自动批）。steer 亦可携带。
   * [product-polish-w2 T2 补抄 zhumo 强度 chip] model：任务级模型/强度覆盖（zhumo
   * 语义：null/缺席=跟随默认）——仅 followup 通道携带（steer+model 服务端 typed
   * 拒），开任务那一刻锁定；daemon 校验路由在场+effort 在目录内。
   */
  followup(
    sessionId: string,
    text: string,
    mode?: 'followup' | 'steer',
    attachments?: string[],
    sourceSetId?: string,
    autoApprove?: boolean,
    model?: { provider: string; model: string; effort?: string },
  ): Promise<{ taskId: string }>
  /**
   * [add-task-stones-manifest-export 1.2] 集合候选读面：sets.list（agent WS 同
   * 路由）摘要投影——新会话首条消息的 Composer 集合选择器数据源。可选实现
   * （RpcAgentApi 真身；mock 演示模式无服务端——缺省即选择器隐藏，与
   * uploadAttachment 注入面同款 UI 在否决定语义）。
   */
  listSets?(): Promise<AgentSetSummary[]>
  /**
   * [product-polish-w1 T1] 市场组合→我的材料复制面：sets.copyFromMarket（源
   * owner=admin 白名单门在 daemon 服务层）→本人副本摘要（origin={kind:'clone',
   * fromSetId} 溯源+成员快照复制）。Composer 发送链消费：选中市场组合发首条消息
   * 时先复制再绑定副本 resourceId 为 sourceSetId（服务端 followup 按 owner 隔离
   * 展开——市场源必拒，副本合法）。可选实现（RpcAgentApi 真身）。
   */
  copyMarketSet?(resourceId: string): Promise<{ resourceId: string; memberCount: number }>
  /**
   * [split-admin-portal 2.6.1] 图片上传面：file→base64→assets.upload RPC→BlobRef，
   * 宽高经 Image 解码，4MiB 前置门+中文错误。可选实现（RpcAgentApi 真身；
   * mock 演示模式无服务端——缺省即附件面隐藏，UI 以在否决定 attachable）。
   */
  uploadAssetImage?(file: File): Promise<AttachmentMeta>
  /**
   * 打断当前轮（add-agent-three-channel 2.1，对齐 shufa b6cec8a tasks.stop——打断≠
   * 终态取消）：任务回 done（可续聊——同会话再 followup 开新任务）。[Codex W10
   * P0-2 裁定=前端外环] 排队消息的延续由前端队列负责（后端 inbox 不承诺）。
   * 无 status 帧——收口由帧流的 done 帧呈现。非 running 幂等；已取消任务拒绝。
   */
  stopTask(taskId: string): Promise<void>
  answer(sessionId: string, requestId: string, approved: boolean): Promise<{ ok: boolean }>
  cancel(input: { sessionId?: string; taskId?: string }): Promise<{ ok: boolean }>
  /** clear 输出（契约同形）：status 区分已清理完成/仍在清理（文件删除失败待重试）。 */
  clear(sessionId: string): Promise<{ ok: boolean; status: 'cleared' | 'clearing' }>
  /**
   * [真链复验 P1-G] 会话改名（session.rename RPC——owner 本人域）：服务端 trim
   * 落库，回显改后标题（调用方就地更新列表，免重拉）。
   */
  renameSession(sessionId: string, title: string): Promise<{ ok: boolean; title: string }>
  /**
   * [prod-run-8317 复盘] 自动批准开关即时落库（session.setAutoApprove RPC——owner
   * 本人域）：免值守场景开关翻转即刻持久化，不再依赖下一条 followup 携带；回显
   * 生效值。
   */
  setAutoApprove(sessionId: string, autoApprove: boolean): Promise<{ ok: boolean; autoApprove: boolean }>
  /** 回放游标以 task 为域（afterSeq 之后无缺失无重复）。 */
  replay(sessionId: string, taskId: string, afterSeq: number): Promise<{ frames: Frame[]; nextSeq: number }>
  sessionResult(sessionId: string): Promise<AgentResultView>
  taskResult(taskId: string): Promise<{ found: boolean } & Partial<AgentResultView>>
  /**
   * 工件字节读面（tasks.artifact RPC——P3.2-channel）：帧流 artifact 帧的
   * {name, blobRef} → {name, mime, dataBase64}；合法引用集=该任务 artifact 帧 ∪
   * 所属会话附件 blob（原图叠加通道）。
   */
  taskArtifact(input: TaskArtifactInput): Promise<TaskArtifactOutput>
  /**
   * 帧订阅：先回放 afterSeq 之后的持久帧，再续收实时帧（断线重连由调用方持
   * lastSeq 游标重订阅）。返回退订函数。
   */
  subscribeTask(taskId: string, afterSeq: number, onFrame: (frame: Frame) => void): () => void

  // ---------------------------------------------------------------- 任务详情·排钻工作台（2.6）

  /** 任务详情组装面（task.detail——六数据源各自可空，前端按在场渲染）。 */
  taskDetail(taskId: string): Promise<TaskDetailResponse>
  /** 人类拆层（layer.split——SAM 单步细分；真桥 1-2 分钟，mock 桥秒回）。 */
  layerSplit(input: LayerSplitInput): Promise<SegmentOneOutput>
  /** 图层改名（layer.rename——直接生效+版本入史）。 */
  layerRename(input: LayerRenameInput): Promise<LayerRenameOutput>
  /** 策略直改（layer.strategy.set——D-1 直接生效：单节点重算+全图预览重渲）。 */
  layerStrategySet(input: LayerStrategySetInput): Promise<LayerStrategySetOutput>
  /** tree 版本列表（tree.history——工作台写操作快照链）。 */
  treeHistory(input: TreeHistoryInput): Promise<TreeHistoryOutput>

  // ---------------- workbench-pro 波 2a 契约消费（2b 前端接线——task.detail 三新面在此面之后）

  /**
   * 笔刷遮罩编辑（layer.mask.patch——workbench-pro 2.3 笔刷闭环）：ops=笔画序列
   * （add/remove 圆盘扫掠，画布 px 坐标）→服务端 mask 重写+bbox/effectiveMm 重算+
   * 版本入史（cause=mask-patch）+可选指派重算（recomputeStrategy）。
   */
  layerMaskPatch(input: LayerMaskPatchInput): Promise<LayerMaskPatchOutput>
  /**
   * 视图态全量快照写（view.state.set——显隐/折叠/锁定=task 级服务端工件：重载/换端
   * 不丢）。CAS：expectedRevision 漂移必拒（双开工作台不静默覆盖）。
   */
  viewStateSet(input: ViewStateSetInput): Promise<ViewStateSetOutput>
  /**
   * 任务导出（task.export——导出门真实接线）：服务端以 mask_edit_states 重算门，
   * allowed=false 时 typed 拒 export-blocked（blockers 原样携带）；放行返回
   * strategy-gems.json 工件字节（filename/dataBase64——前端下载产物）。
   */
  taskExport(input: TaskExportInput): Promise<TaskExportOutput>
  /**
   * 图层重排（layer.reorder——workbench-pro 2c 图层管理）：父变更+序位；CAS 门
   * （expectedTreeBlobRef 漂移拒）+环路/根保护/锁定 typed 拒；cause='reorder' 入史。
   */
  layerReorder(input: LayerReorderInput): Promise<LayerReorderOutput>
  /**
   * 删子树（layer.delete——workbench-pro 2c 图层管理）：子树全集出树+指派收敛
   * （removedAssignmentNodeIds）+存量 plan 重算 gems；根保护/锁定/CAS 拒。
   */
  layerDelete(input: LayerDeleteInput): Promise<LayerDeleteOutput>
  /**
   * 整树快照回退（tree.revert——undo tree-structure 域载体，D-3）：目标版本须在
   * tree.history 链上；revert 自身入史（历史只增不删）。W10 复核指出前端缺此 API
   * ——2c 补齐。
   */
  treeRevert(input: TreeRevertInput): Promise<TreeRevertOutput>
  /**
   * stale/error 重放重算（maskEdit.retry——恢复链，终评 P0-1）：CAS=现读留痕
   * baseVersion（漂移必拒 cas-mismatch）；返回重放后的留痕行（终态 ready/error；
   * 竞态被新编辑接管时=新行现值）。
   */
  maskEditRetry(input: MaskEditRetryInput): Promise<MaskEditRetryOutput>
  /**
   * 确认放弃编辑留痕（maskEdit.discard——恢复链，终评 P0-1）：删阻断留痕行
   * （stale/error/incomplete——mask 已落盘如实不回滚，仅清告警/门阻断面）；行已
   * 不在=幂等成功（discarded=false）。
   */
  maskEditDiscard(input: MaskEditDiscardInput): Promise<MaskEditDiscardOutput>
}
