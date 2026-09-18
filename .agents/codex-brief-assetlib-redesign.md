# Codex 评审任务：add-asset-library + redesign-studio-layout（R1）

你是评审人。工作目录 `/Users/kzf/Pictures/贴钻`（git 仓库根；应用在 `rhinestone-studio/`）。
基于**真实源码与真实文档**评审两个新 openspec change 的开工准备度。不得只复述设计自评。

## 必读（按序）

1. `rhinestone-studio/PRODUCT_MODEL.md`（产品模型，评审必读前置）
2. `.agents/documents/2026-09-19-asset-library-design/asset-library-and-studio-redesign.md`（PM 设计稿全文：§1 现状盘点含源码行号证据、§2 素材库、§3 工作台重设计、§6 与手动编辑的冲突）
3. `openspec/changes/add-asset-library/{proposal,design,tasks}.md` + `specs/asset-library/spec.md`
4. `openspec/changes/redesign-studio-layout/{proposal,design,tasks}.md` + `specs/studio-workbench/spec.md`
5. 对照源码（关键处）：`rhinestone-studio/src/lib/persistence/{imageStore,taskStore}.ts`、`src/lib/stores/{lab,studio,edit,handoff}.svelte.ts`、`src/lib/presets/effectRefs.ts`、`src/lib/components/views/StudioView.svelte`、`src/components/Studio/{CompareGrid,ExportBar}.svelte`、`openspec/changes/add-manual-edit-mode/design.md`（§1 已冻结契约，本波要动它的 referenceDataUrl）
6. 现状测试面：`rhinestone-studio/src/tests/`（lab/studio/edit 三域，350 用例全绿基线）

## 评审输出（固定格式）

### A. 五议题裁决（每条给结论 + 理由 + 采纳/否决/修改 PM 立场）

1. blob 复用既有 `images` store vs 新建 `assetBlobs`（PM 立场：复用）
2. handoff 引用化（assetId 载荷）与烘焙边界——含 C-1/C-2：趁 add-manual-edit-mode 未关窗口改 `referenceDataUrl → referenceAssetId` 是否正确（PM 立场：改；降级方案 dataUrl 双写一版）
3. 生成结果归档：按批次文件夹 vs 平铺+过滤（PM 立场：按批次）
4. 工作台布局方案 A（舞台+检查器+胶片带+对比模式）vs 方案 B（双栏常驻对比）（PM 立场：A；若你认为 CompareGrid 拆分风险大于重排收益，需给具体风险点）
5. 删除语义 P0 软删（回收站）vs P0 硬删+P1 回收站（PM 立场：软删）

### B. 阻塞问题（能阻断开工的契约/实现矛盾，逐条给可验证修复建议；对照真实类型与函数签名）

### C. 开工判定与评分

- 每个 change 独立输出 GO / NO-GO + 综合评分（0-10）+ 评分依据
- 两 change 的并行/依赖关系是否如设计所述成立（选图器签名先冻 + C-4 送精修入口迁移）

## 硬性要求

- 类型/签名断言必须对照真实源码（如 `HandoffPayload`、`ManualEditHandoff`、`PersistedTaskMeta`、IDB schema）。
- 迁移方案（design §3）重点审：幂等性、失败恢复、v1 回退路径是否真实成立。
- 布局 change 重点审：拆分映射（design §2）的组件边界与测试迁移风险；移动端硬承诺是否有测试兜底。
- 简短直接，不写客套；结论必须可执行。
