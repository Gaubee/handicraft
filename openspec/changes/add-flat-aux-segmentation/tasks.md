# Tasks: add-flat-aux-segmentation（参考图层——Owner 定名 2026-10-04）

> Owner 指令（当日）：「加入这个『参考图层』是对的。但还没把它规范化：没整合到我们的工作流。」
> 设计决策见 design.md（D1-D6）。§0 前置实弹已闭合；T1-T7 为主体实施。

## 0. 前置实弹·工作画布确定性（Owner 报障 2026-10-04「辅助图 512×512mm 未铺满画布」根因修复）

> 归属说明：本修复是 proposal §1「四图引用分离/坐标一致性」门的第一实弹——iter-5 会话
> 76b63ed7 实证的分析锚（500px/ppm 2.5）与树锚（1280px/ppm 6.4）分叉，正是该门要防的
> 坐标系漂移。proposal §1 验收里的「1280 树+500 分析图定向回归」已在 daemon 侧落地
> （segment-tool.test.ts [3b] Bug A 回归），change 主体（风格检测/辅助图生成/几何一致性门）
> 仍在立项推进。

- [x] 0.1 Bug A（daemon）：`planIntakeResample` 改规范网格恒等推导（canvasCm 在场时
      imagePx 恒=round(canvasCm×ppcmTarget)，与上传格式/尺寸无关；升采同采——旧「只降
      不升」废止；纵横比漂移>2% 透传保留 S1 显式拒迟到面）；`resampleRgbaArea` 升采同式
      （box 上采样）；新增 `applyIntakeResample` 入线编排单源（intake-image.png 工件+帧）
- [x] 0.2 Bug A（接线）：subject.segment 入线接入推导（elements 直注跳过 scene.analyze
      的路径同样推导——iter-5 分叉根因）+kernel 装配 intakeConfigProvider（与
      scene.analyze 同源）；确定性推导使两入线口各自调用亦得同一 blobRef（锚点互洽）
- [x] 0.3 Bug B（契约/投影）：TaskDetailTreeSchema 增 canvasCm/imagePx（树=工作画布
      真源锚）+task.detail 投影
- [x] 0.4 Bug B（UI）：工作台取锚序 tree→gems→baseImage（旧序 baseImage 优先把
      500px 分析声明配 1280px bbox——1280÷2.5=「512×512 mm」幻数+辅助图不铺满双症状）；
      废弃 `{w: imagePx/2}` 伪造 canvasCm 兜底（无锚=PIXELS_PER_MM 显式降级 exact=false）
- [x] 0.5 回归：intake-resample 双路同锚（3000/1280/736/400→同一 500）+设置跟随
      （40px/cm→800）+aspect 漂移透传；scene.analyze 升采/幂等；segment-tool iter-5
      定向（原始 1280 blob+elements→树 500×500+同锚二调零变迁）；studio 树锚 6.4 ppm
      回归（1280 树+500 baseImage 分叉→mm=px÷6.4=200 满幅）
- [x] 0.6 兼容性：旧任务（500px 与 1280px 双型）树/布局工件已落盘自洽——task-layout
      ppm=imagePx/(canvasCm×10) 单源不变，旧档零迁移零重算；修复只影响**新任务**的入线
      推导（透传幂等：已在规范网格上的锚点零变迁）

## 1. 风格检测与辅助图链路（change 主体——立项中）

- [x] 1.1 design：风格检测判据（低梯度/平坦色域占比 vs VLM 判定）+辅助图生成通道选型
      ——design.md D1/D2 落地：判据=VLM style 判定入 S2 提示词（T1，flat/semi-flat/
      photographic 三值，判定失败缺省不阻塞）；通道=image-edit provider（T2，OpenAI
      images/edits 兼容 v1，admin models 设置面）
- [x] 1.2 四图引用分离：原图/辅助图/scene-analysis 降采样图/树掩膜源图显式引用+坐标
      变换关系；修 P1 树编辑锚点（tree.ts:108）；1280 树+500 分析图定向回归（daemon 侧
      已由 0.2 覆盖入线推导面，本项覆盖树编辑面）——T1/T3 波落地（2026-10-04：style
      判定入 S2、referenceImage 任务引用面、树锚 imageBlobRef+树编辑单源、账本分账）
- [x] 1.3 辅助图几何一致性门：掩膜一一映射回原图校验；不一致回退原图流程或显式变换
      ——T2 2.3 落地：referenceImageConsistency 剪影 IoU≥0.85（border-median 背景
      估计+diff 30 阈值；尺寸不同先对齐）；不过→工件保留供人审但不发
      reference-image.png 帧（读面继续回退原图）+warning 留痕
- [x] 1.4 scene-analysis 稳健性：输出规模与重试预算有界（iter-5 三连败教训）
      ——输出规模=LLM 调用恒带 maxTokens 界（scene-analyze.ts:257-320
      max_tokens/max_output_tokens 三协议形态）；重试预算=capability 面
      RUNAWAY_LIMIT=5 同错连击熔断（vision capabilities noteFailure——连续 5 次相同
      失败→typed 熔断消息令 agent 停止重试向用户报告）
- [x] 1.5 策略冻结：密度/点缀风格显式选项或默认规则；部件级钻数从最终 layout 复核
      ——T4 4.4 落地：PavingStyleSchema full/accent 显式选项+表单行+提示词铺法行；
      部件级钻数终局实算（nodeSummaries 从 finalGems 按 blockId 重算+导出终报恒从
      task-layout 实算）；默认值=Owner 裁决位（缺省不指定交策略）

## T1 风格检测（design D1）
- [x] 1.1 scene-analyze schema+提示词增 style 判定（flat/semi-flat/photographic；判定失败缺省不阻塞）+测试
- [x] 1.2 任务工件记录 style+触发决策留痕

## T2 参考图层生成（design D2）
- [x] 2.1 image-edit provider 类型（admin models 设置面新形态：OpenAI images/edits 兼容 v1）
      ——T2 波落地（2026-10-04）：ROUTE_APIS 增 openai-image-edit（contracts 单源+studio
      route-meta 镜像，UI 协议 select 零 svelte 改动）；resolveImageEditRoute(db) 解析单源
      （default 模型优先/无密钥 null）；对话路由解析（resolveLlmRoute）与 pi-ai 内核桥
      （buildRoutesBundle）/对话 chip（modelsAvailable）三面排除该值（非对话协议）；
      连接测试 v1 不做 ping（生成即探测——detail 明示）
- [x] 2.2 生成编排：Owner 提示词常量（测试逐字锚定防漂移——iter-5-flat-ab/owner-flatten-prompt.md 全文）→reference-image.png 工件+帧；失败软回退+typed warning
      ——kernel/vision/reference-image.ts：OWNER_FLATTEN_PROMPT 逐字常量（3874 字节
      sha256 锚定注释+测试双副本逐字节 ===）；generateReferenceImage 全路径软失败
      （unconfigured/failed typed warning 不阻塞）；触发接线=scene.analyze capability
      handler（S2 完成→S3 前，style=photographic 才触发，兜底 catch 保 S2 主产物）；
      幂等=reference-image.png artifact 帧在场零外呼；外呼超时 env
      REFERENCE_IMAGE_TIMEOUT_MS 缺省 180s；工件字节恒对齐原图网格（分件坐标系自洽）
- [x] 2.3 几何一致性门：剪影 IoU≥0.85（vision 审计法程序化移植）+轮廓漂移报告；不过→回退原图+留痕
      ——referenceImageConsistency 纯函数（border-median 背景估计+diff 30 阈值→双剪影
      →IoU≥0.85；尺寸不同先 resampleRgbaArea 对齐）；生成成功即自动跑门；数字落
      reference-image-report.json 工件帧两态留痕；不过→工件保留供人审但不发
      reference-image.png 帧（task.detail 读面继续回退原图）+warning reference-image-inconsistent

## T3 四图引用分离（design D3）
- [x] 3.1 任务级 sourceImage/referenceImage 显式引用（contracts+工件）；旧任务兼容（referenceImage 缺省=source）
- [x] 3.2 树工件增 imageBlobRef 锚；树编辑（reparent/refine/merge/rename）全用树锚引用（tree.ts:108 修正）；账本键含 referenceImage
- [x] 3.3 测试：1280 树+500 分析图定向回归扩展全树编辑面；换参考图层=新账本域

## T4 分件与排钻双通道（design D4）
- [x] 4.1 分件全工具面输入=referenceImage（intake 确定性照旧）
      ——T4 波落地（2026-10-04）：任务级单源接线（reference-image.ts
      latestReferenceImageBlobRef 帧流读回）；subject.segment 服务端自动以参考图层为
      送桥输入/树锚/账本分账键（缺省=原图零变化；陈旧参考图层=typed warning
      reference-image-unusable 软回退；agent 直传参考图层 blob=锚校验容忍）；出参
      segmentImage 溯源。树面（tree_refine/layer.split/segmentOne）经 T3 树锚单源
      自动跟随（树锚=分件输入图同源一致——本批输入侧收口）；账本
      fingerprint/reqHash referenceImage 实跑分账（不同参考图层=不同账本域集成测试）
- [x] 4.2 策略层双图（结构=参考图层/色彩细节=原图：策略设计工具预览带双图）
      ——propose 结果 agentImagePreviews 复用（kind='reference-source-pair'——左
      参考图层/右原图/深色中缝合成缩略，AgentImagePreviewSchema.kind 开放 string
      零 contracts 变更）；执行链亮度场真源=原图（resolveStrategyLumaSourceRef 单源：
      无参考=树锚/参考在场=scene-analysis 锚宁缺毋假；texture-fill/straight-line
      缺省注入 params.lumaB64=bbox 原图灰度——不落 plan 工件派生量）
- [x] 4.3 归属门：导出前 bbox→叶子归属核对自动化+attribution-gaps 明细+warning（v1 披露不阻断）
      ——kernel/vision/export-audit.ts auditLeafAttribution（KB b35032e 判据程序化：
      semantic-no-leaf=语义容器子树叶自覆盖<10% 且 ≥90% 被非本子树叶覆盖；
      leaf-covered-by-leaf=产钻叶 ≥90% 被另一叶覆盖——编辑残留）；落点=task-export
      runExportGates [4]（propose/execute warnings+audit 明细+任务流披露帧+bundle
      manifest audit 段）
- [x] 4.4 密度/钻规格策略冻结面（满铺/点缀显式选项——含 Owner 裁决位）+分部件数字从终局 layout 复核
      ——contracts PavingStyleSchema（full/accent；**默认值暂不设=缺省不指定交策略
      ——Owner 裁决位备注待定**）；strategy.design pavingStyle 入参+提示词铺法行+
      proposal payload；表单行（followup 首消息「铺法：满铺/点缀」——newTaskComposer
      与画布尺寸行同模式+parsePavingStyleLine）；部件级钻数终局实算（执行链
      nodeSummaries 以 finalGems 按 blockId 重算+导出终报 parts 恒从 task-layout
      实算——iter-5/6「终报数字与终局不符」根治）

## T5 导出双图门（design D5）
- [x] 5.1 导出五产物基图恒=sourceImage；参考图层零泄漏（产物级断言）
      ——考古结论：SVG #source 与 bundle source.img 本就读会话主图集附件（用户
      上传原始字节——与参考图层/树锚零关联），本批显式化（sourceImageOfSession 携
      blobRef 入 bundle manifest audit.sourceImage 引用留痕）+产物级断言测试（source.img
      字节=附件原图 byte 级；SVG dataUrl 锚；五产物参考图层字节/base64 零泄漏搜索）
- [x] 5.2 布局→原图轮廓对齐抽样校验+异常 warning
      ——export-audit.ts auditLayoutAlignment（种子化 LCG 确定性抽样 N=200；锚点
      在本 blockId 掩膜内或 ±2px 容差邻域；异常率>5%=layout-alignment-suspicious
      warning 带样本明细——v1 披露不阻断）；task-export runExportGates [4] 接线
      （seed=planRef 回放确定；TaskLayoutSchema/engine 门已阻 blockId 悬空与出膜
      layout——本审计为 schema/engine 门之上的终检披露面）

## T6 工作台 UI（design D6）
- [x] 6.1 图层面板「参考图层」条目（查看/重新生成/禁用重跑）+版本史留痕
      ——T6 波落地（2026-10-04）：daemon `task.reference` 三端点（regenerate=
      approved-mutation 双模——stones.add A 修法形态：propose 前置查（provider/
      scene 锚）不签空提案+approvalFaceOf autoApprove 立即执行指令；execute=
      consumeForExecution→generateReferenceImage force=true 清幂等重跑+一致性门
      +settleExternal 终态；disable/enable=本地标记直写面）。禁用语义=帧流
      latest-wins 标记帧（reference-image-disabled.json 工件+帧+log 留痕）压过生成
      帧——subject.segment 分件输入/策略双图预览/task.detail 读面三处同源回退
      原图（latestReferenceImageBlobRef→referenceImageStateOf 单源）；enable=重申
      生成帧零外呼；scene.analyze photographic 自动触发尊重禁用标记（不翻回用户
      显式覆盖）。task.detail 投影扩展：disabled/referenceBlobRef（工件本体——UI
      缩略/查看大图锚，禁用态仍在档）/consistency（report 工件数字 best-effort）。
      studio：WorkbenchReferenceLayer 条目（面板顶部；三态 未生成/在场/禁用；
      非可排钻层结构保护同画布根；一致性数字行+查看大图内联展开+重新生成授权流
      loading+禁用确认面重跑分件提示+pending 期 approval-resolved 帧监听自动执行）
      ；AgentApi 三面（rpc/types/mock——mock 恒 autoApprove 走通全链）
- [x] 6.2 jsdom 测试+vision 走查
      ——jsdom 波随 6.1 落（workbench.referenceLayer.test.ts 4 例：三态渲染/重生成
      autoApprove 链/禁用确认+blobRef 回退+启用复活/大图展开；daemon 侧
      flat-aux-t6.test.ts 14 例：状态机纯函数/RPC 双模授权两态+幂等清/禁用后分件
      回退集成）；vision 走查 2026-10-05 完成（8317·159d72c，8/8 PASS：B1「未生成·
      分件用原图」态实况+挂锁+非可排钻层结构不可选；B2 重新生成→前置 typed 拒
      「image-edit 路由未配置…配置后再发起」（未签提案未外呼，autoApprove 不被
      绕过）；B3 分享包五产物 200+魔数正确+原图/产物双滑杆混合预览像素级生效。
      截图 /tmp/final-walk/，判定见交付批走查报告）

## T7 旗舰回归
- [ ] 7.1 三天使图全链（photographic→自动参考图层→分件→排钻→导出原图）：验收五条+四图各就其位
      ——T7a live 跑批（`experiments/sam-playbook-20261004/t7a-flagship/`，daemon ba20c68）：
      run2 全五条 PASS+新面四证据 live（style 检测/参考图层软回退/归属门 4 条披露/
      导出原图门字节恒等）；**run1 意外发现 P1「JPEG 直传 S0 死链」**（原版微信 JPG
      经 RPC 直传 → scene_analyze/subject_segment/pave-preview 三面 image-decode-failed
      全拒 → agent 6.3min 零分件诚实终报）→ **P1 修复已落**（下方 7.0）。
      **2026-10-05 补证**（codex-final-r1 需修①）：HEAD 159d72c 真实 JPEG 直传 live
      回归 12/12 PASS（`t7a-flagship/jpeg-live-regression/`：run1 同字节重放→归一 ref
      全链单源→S2 photographic 正常产出→~2min done）。**仍开放**：真实参考图层生成
      路径（生成成功/IoU 过门/分件实际采用/生成失败与门不过的 live 形态）待 Owner
      在后台配置 image-edit 路由后重跑——codex-final-r1 Owner 裁决位④
- [x] 7.0 P1 修复：会话入线 PNG 归一单源（2026-10-04，t7a run1 异常①）
      ——根因：PNG 归一只存在于 UI 客户端（agentApi/attachments.ts convertImageToPng，
      W5 P0-2）；RPC 直传路（assets.upload→session.followup）无任何归一，JPEG 字节
      原样入会话撞视觉管线 PNG-only 解码面（scene-analyze/segment-tool/segment-one/
      workbench/pave-preview 五处 decodePng）。修复选型=**上传面统一转码（单一真源）**：
      `kernel/attachment-normalize.ts` normalizeAttachmentsToPng 在 followup 单漏斗把
      非 PNG（jpeg/webp，sharp 解码+EXIF 方向归一+encodePng 确定性编码）转码为新 PNG
      blob+归属入账——prompt 锚注/tasks.params 审计/images.list/导出 source 全链只见
      归一 ref（无 ref 双源）；PNG 直传零变化（sniff 直通）；不可判定面（归属/可读/
      白名单）原样透传由治理面既有语义拒。S0 解码面=防御断言（四入口消息收紧：
      「管线仅支持 PNG——会话附件入线已归一；非 PNG ref=绕过入线直传」）。sharp 为
      daemon 闭包内既有原生依赖（dsh-attachment-local 同源），显式声明 0.35.4 同实例。
      测试 `tests/attachment-normalize.test.ts` 12 例：归一矩阵（PNG 零变化/JPEG→PNG/
      EXIF 方向/WebP/混合逐位/非本人透传/伪图透传/坏 JPEG typed 拒/幂等/数量超限整组
      透传）+ run1 复现链（JPEG 直传→归一→scene.analyze style=photographic 正常产出
      +工作画布 500×375 PNG 锚点）+ 防御断言存活（原 JPEG ref 直调仍 image-decode-failed）；
      邻面回归 scene-analyze/segment-tool/segment-one/kernel/attachments-chain/
      project-first-followup 全绿（162 例）；typecheck 绿。
      **2026-10-05 补证①/④落地**：8317 已部署（159d72c，PID 80133）——live 回归
      12/12（同上 7.1 注）；UI 客户端转换器职责显式化（预转换优化，服务端=权威单源，
      零行为变更——attachments.ts [4]/rpc.ts 调用点注释声明两侧共同不变量）
- [x] 7.2 回退四态（flat/禁用/生成失败/一致性门不过）集成测试
      ——四态全覆盖（分散于两文件，2026-10-05 复核）：flat=reference-image.test.ts:615
      （style flat → 不生成，image-edit 零调用）；生成失败=:396（HTTP 坏）/:417（无
      b64_json）/:434（b64 非 PNG）三例（failed typed warning 软回退+零工件帧）；
      一致性门不过=:261（纯函数数字明细）+:453（工件保留供人审+report 帧留数字+
      reference-image.png 帧缺席=读面回退原图）；禁用=flat-aux-t6.test.ts:212-227
      （referenceImageStateOf 状态机 latest-wins 压过生成帧）+禁用后分件回退集成。
      加发：photographic 触发 :593/未配置软回退 :641/幂等 :378/无 style 缺省 :628
- [x] 7.3 Codex 终审+8317 部署+Owner 交付
      ——终审=codex-final-r1（2026-10-05，gpt-6.1-sol xhigh）：三 change 裁定+旗舰
      证据独立复算（source.img SHA-256 三方一致）→ 战役「研发/灰度条件 GO，正式
      发布与完整归档 NO-GO」+4 需修/补证+4 Owner 裁决位；**增量复审**（同会话）：
      ①③④闭合（8.7/10 条件 GO 维持）+UI 三态证据采信，②待 Owner 配置。全文落档
      `codex-final-r1.md`（含增量批）；vision 双走查 8/8 落档
      `vision-walkthrough-20261005.md`（截图归档 experiments/…/final-walk-20261005/）。
      8317=159d72c 部署运行中（PID 80133；f2a7bde 为纯注释/文档增量零运行时差）。
      Owner 交付=交付报告（本批发出，含 4 裁决位清单）；Owner 最终验收=Owner 侧
      动作（既定「你持续推进，我只做最终验收」分工）
