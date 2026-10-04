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

- [ ] 1.1 design：风格检测判据（低梯度/平坦色域占比 vs VLM 判定）+辅助图生成通道选型
- [x] 1.2 四图引用分离：原图/辅助图/scene-analysis 降采样图/树掩膜源图显式引用+坐标
      变换关系；修 P1 树编辑锚点（tree.ts:108）；1280 树+500 分析图定向回归（daemon 侧
      已由 0.2 覆盖入线推导面，本项覆盖树编辑面）——T1/T3 波落地（2026-10-04：style
      判定入 S2、referenceImage 任务引用面、树锚 imageBlobRef+树编辑单源、账本分账）
- [ ] 1.3 辅助图几何一致性门：掩膜一一映射回原图校验；不一致回退原图流程或显式变换
- [ ] 1.4 scene-analysis 稳健性：输出规模与重试预算有界（iter-5 三连败教训）
- [ ] 1.5 策略冻结：密度/点缀风格显式选项或默认规则；部件级钻数从最终 layout 复核

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
- [ ] 6.1 图层面板「参考图层」条目（查看/重新生成/禁用重跑）+版本史留痕
- [ ] 6.2 jsdom 测试+vision 走查

## T7 旗舰回归
- [ ] 7.1 三天使图全链（photographic→自动参考图层→分件→排钻→导出原图）：验收五条+四图各就其位
- [ ] 7.2 回退四态（flat/禁用/生成失败/一致性门不过）集成测试
- [ ] 7.3 Codex 终审+8317 部署+Owner 交付
