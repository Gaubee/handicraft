# design — add-flat-aux-segmentation（参考图层）

> Owner 定调（2026-10-04）：「基于我改进后的图层，抠图效果确实更好了。加入这个『参考图层』是对的。但还没把它规范化：没整合到我们的工作流。」
> A/B 终裁（iter-6 干净重跑）：分件质量（星 45.8→70.1%/袍 ~55%/阈值战场 20→1）、效率（−38%）、BOM 简化成立；同色粘连=已知代价（归属门处置）；产品化条件 GO 五门=本设计主体。

## D1 触发面（风格检测）

- scene-analyze VLM 已是 S2 必经——**其输出 schema 增 `style: 'flat'|'semi-flat'|'photographic'`**（提示词一并教判定：贴钻实物照/照片=photographic；插画平涂=flat）
- `photographic` → 触发参考图层生成；`flat` → 直接原图。缺省（判定失败）→ 原图流程（不阻塞）
- 用户显式覆盖：任务表单/会话可指定「禁用参考图层」（后续波；v1 自动判定）

## D2 参考图层生成（image-edit 通道）

- 新 provider 类型 `image-edit`（admin models 设置面配置；v1 目标 API=OpenAI images/edits 兼容形态——Owner 实证有效；后续可扩展其它）
- 生成指令=**Owner 提示词逐字冻结**（iter-5-flat-ab/owner-flatten-prompt.md 全文，代码内常量+测试锚定防漂移）
- 产物落任务工件 `reference-image.png`（blob+帧留痕）；生成失败→typed warning+回退原图流程（软失败）
- 几何一致性门（生成后立即）：参考图层与原图做结构相似性校验（v1：剪影 IoU≥0.85（vision 审计法同款）+轮廓漂移报告；低于阈值=回退原图+warning 留痕）

## D3 双通道数据模型（四图引用分离）

任务级显式引用四图，各名其职：

| 引用 | 来源 | 用途 |
|---|---|---|
| `sourceImage` | 用户上传原图（归一后） | 展示/导出/分享 source.img/最终叠加 |
| `referenceImage` | D2 生成（或=source 当 flat/禁用） | **分件/SAM/掩膜真源/参考图层 UI** |
| `analysisImage` | scene-analyze 入线降采样 | S2 分析锚点 |
| 树掩膜源 | =referenceImage（树锚点 imagePx/canvasCm 记录之） | 树编辑/账本坐标 |

- 树工件已带 imagePx/canvasCm（673a87d）；补 `imageBlobRef` 显式锚——**树编辑操作（reparent/refine/merge/rename）一律用树锚引用**，不再从 scene-analysis 取图（Codex P1 锚点 tree.ts:108 修正）
- 回放/账本键含 referenceImage 引用（换参考图层=新账本域，不串）

## D4 分件与排钻链路

- 全层面（subject.segment/tree_refine/layer.split/点/box/excludeBox）输入图=referenceImage（intake 确定性推导照旧——canvasCm×ppm 规范网格）
- 排钻策略亮度场/纹理取图：**策略层用原图**（同色粘连代价的缓解：结构来自参考图层、色彩细节来自原图——策略设计时两图都可看：工具结果预览带双图）
- 归属门（Codex 门 4）：导出前 bbox→叶子归属核对自动化——要求部位区域若 ≥90% 被邻层掩膜覆盖且无本叶：导出工件记 `attribution-gaps` 明细+任务级 warning（阻断 vs 披露：v1=披露+明示，不硬阻断——Owner 可裁决升级）

## D5 导出面（Codex 门 3）

- 导出五产物基图**恒=sourceImage**（render/holes/numbered/svg 的 source 语义；混合预览=钻布局+原图）
- 参考图层不出现在任何导出产物/分享页
- 布局落点与原图轮廓对齐检查：布局 gems 投影回原图掩膜域抽样校验（v1：抽样锚点+报告，异常 warning）

## D6 工作台 UI（「参考图层」呈现）

- 图层面板顶部「参考图层」条目（可查看/可手动重新生成/可禁用后重跑分件）——不做可排钻层（结构保护同画布根）
- 版本史/审计帧：参考图层生成/一致性门结果/禁用重跑均留痕

## 验收口径

1. photographic 图建任务 → 自动生成参考图层（Owner 提示词原文在 wire/日志可证）→ 一致性门数字留痕 → 分件在参考图层上 → 导出产物基图=原图（source.img 字节=原图）→ 分享页无参考图层痕迹
2. flat 图/禁用/生成失败/一致性门不过 → 全链走原图（回退路径四态各有测试）
3. 树编辑用树锚引用（1280 树+500 分析图定向回归绿——673a87d 已建，扩展到 reparent/merge）
4. 归属门：构造同色粘连用例 → attribution-gaps 明细+warning
5. 三天使图全链旗舰回归：验收五条全 PASS+四图引用各就其位
