# 实现终审：设计师工作台重写与两项后续 change

审查对象：`redesign-designer-workbench`、`rework-designer-manual-rhinestone`、`enforce-lab-prompt-wysiwyg`。依据当前 HEAD `e7484da`、真实源码与 diff、独立测试输出及 change 内走查收据；本报告不修改源码或其他 change 文档。

## 结论

**NEEDS-WORK，综合 7.8/10。无 P0；存在三个 P1。**主体实现已经接近可交付：变换、笔刷面积落子、跨视图键盘守卫、隐藏层投影、提示词同源预览/发送、seed v3 改过不重播均有源码与测试支撑。但 PNG/画布块边界算法存在真实边界缺陷，redesign 仍有未闭合任务，且 WYSIWYG change 没有可被 strict validator 读取的 delta；因此不能给三个 change 无条件 GO 或归档 GO。

## P1 阻塞

### P1-1：blocks 左右边界跨行取样，PNG 与实时画布同时漏画竖边

- `rhinestone-studio/src/lib/designer/pngRender.ts:245-249` 和 `rhinestone-studio/src/components/Designer/DesignerCanvas.svelte:276-280` 直接读取 `label[gy * W + gx - 1/+1]`、`label[(gy +/- 1) * W + gx]`，没有 `gx/gy` 边界守卫。
- 当块覆盖整行宽度时，`gx=0` 的 `-1` 会读上一行末列，`gx=W-1` 的 `+1` 会读下一行首列；若仍属同一 block，边界被误判为内部，导致中间行左/右竖边消失。两处复制算法会使导出 PNG 与画布出现同样错误，并且边界结果会随相邻内容改变。
- 当前测试覆盖角点/内部像素，但未覆盖“满宽块的中间行左右边缘”，所以 `pnpm test` 绿不能排除该缺陷。

可验证修复：抽出共享纯 helper，越界邻居统一视为 `-1`，或显式使用 `gx > 0`、`gx + 1 < W`、`gy > 0`、`gy + 1 < H`；为 PNG 与画布各补一个满宽/满高块的左右边界断言，再复跑真实浏览器像素检查。

### P1-2：redesign 的完成口径与任务状态不一致

`openspec/changes/redesign-designer-workbench/tasks.md:81-83` 的 `9.2`、`9.2b`、`9.3` 仍为 `[ ]`。`walkthrough-r3.md:14-15` 虽声明 vision gate PASS，却明确把 `9.3 Owner 真浏览器走查（5200）`保留为后续工作。这与“0.x-9.x 全勾/实现全部完成”的前提冲突，属于交付契约闭环阻断，而非已登记的普通 UX 债。

修复路径二选一：完成三项并补真实浏览器收据后勾选；或经 Owner 明确裁决，将真实浏览器验收正式迁出本 change，标注 deferred、责任人、验收标准和不影响本 change 的边界。之后重跑 strict OpenSpec、全量测试与 check。

### P1-3：WYSIWYG change 无 delta，strict OpenSpec 无法验证其契约

`openspec/changes/enforce-lab-prompt-wysiwyg/` 当前只有 `proposal.md`，没有 `specs/` delta（也没有 `skip_specs: true`）。独立运行 `openspec validate --strict --changes` 时该 change 报 `Change must have at least one delta. No deltas found.`。源码实现确实已收敛为占位符替换，但缺少可解析的 ADDED/MODIFIED/REMOVED requirement，无法把实现与 byteEq 公理建立正式 change 契约。

修复：补齐包含 `#### Scenario:` 的 delta spec，或若该 change 有意为纯实现/文档变更，提交并说明 `skip_specs: true`；随后重新验证，不得以 proposal 自述替代 spec delta。

## 实现核对

### redesign-designer-workbench

- Delete 裁断与单/批量确认、Undo 语义在命令面保留；`EditGemFields`/`assetId` 对称改写与 custom 必带 assetId 的条件项已写入 design，brush 侧有 resolver、物化和 missing-asset 测试方向。
- `gemdocLifecycle` 与 `quickLayout` 的开窗符合 design 随记：迁移/保存装配与 API 面扩展，计算内核和冻结参数保持；实际 diff 中 `projectFile.ts`、`documentService.ts`、`gemdocLifecycle.svelte.ts`、`quickLayout.ts` 是行为开窗，其余 persistence/edit 文件主要是术语或注释同步，应在最终收据逐文件列明。
- engine 护栏：`git diff --stat 2f56af2..HEAD -- rhinestone-studio/src/lib/engine` 非零仅因 `edit.ts`、`index.ts`、`types.ts` 三处术语注释；未见行为改动，符合已登记的 R0 注释例外，不应宣称字节零 diff。
- redesign 设计中的 Delete、旧智能排布 UI 退役但保留内核、以及 `[ ]` 让渡笔刷直径等裁断与实现方向一致；未勾 9.x 仍阻断 change 完成声明。

### rework-designer-manual-rhinestone

- R1-R5 实现任务均已勾选；R3.2 中的 `[ ]` 是键位正文“让渡笔刷直径”，不是未完成 checkbox。
- `interaction.svelte.ts` 保存 transform mode/pending；`gestures.ts` 的 `buildTransformChanges` 只生成 `diameterMm`/`rotationDeg`，不写 `x/y`，满足尺寸安全 invariant。⌘T 多选、Enter/Esc、`⌥[`/`⌥]` 15°路径与跨视图 active-view 键盘守卫均有 focused 覆盖。
- `brushEngine.ts` 有 capsule sweep、settled-cell 去重、确定性 flow 嵌套、批内碰撞拒绝及 footprint erase；focused tests 覆盖宽带、多行、稀疏/稠密等价、flow、碰撞和擦除。
- `documentService.ts` 在 SVG/BOM/PNG/gate 前投影 visible gems，默认 service 接到 `renderEditDocumentPng`；因此隐藏层不进入导出链的调用关系成立，但 P1-1 仍影响 block 边界像素。
- 真实浏览器的变换链和真实 canvas PNG 仍主要来自 supplied `walkthrough-r3`；jsdom/recording canvas 只能证明状态链路，不能冒充浏览器 E2E。

### enforce-lab-prompt-wysiwyg

- `composeDrillPrompt` 已成为占位符替换函数；`buildFinalPromptPreviews()` 与 `runStage()` 共用它，`prompt.byteEq.test.ts` 覆盖开关关闭且无占位符时的字节等价。
- `DRILL_RULES` 已移入 v2/v3 seed 正文；`templateSeed.ts` 的 retirement 为 create-only，并保留 modified templates，测试覆盖未修改、已修改和幂等路径。
- 缺少 delta spec 是本 change 的契约/归档阻断（P1-3）；byteEq 仍建议补缺 asset、物化失败、占位符组合等分支，防止 preview/send 在失败回退时漂移。

## 独立门禁与证据边界

本轮独立复跑：

- `pnpm check`：`svelte-check found 0 errors and 0 warnings`。
- `pnpm test`：166 个 test files 通过，2050 tests passed、1 skipped；输出有大量 jsdom `HTMLCanvasElement.getContext()` 未安装 canvas 的非失败提示。
- 聚焦复跑（transform、brush、PNG、cross-view keyboard、byteEq、preview、seed）：7 files / 59 tests，exit 0，约 11.88s；PNG 使用注入 renderer，transform 使用 jsdom synthetic pointer，不能替代真实浏览器/真实光栅。
- `openspec validate --strict --changes`：12 passed、3 failed。失败为 `add-designer-selection-paths`、`add-manual-edit-mode` 无 delta，以及本审查对象 `enforce-lab-prompt-wysiwyg` 无 delta；`redesign-designer-workbench` 与 `rework-designer-manual-rhinestone` validator 通过。`enforce-lab-prompt-wysiwyg` 的 archive refusal 信息也显示现有 prompt-lab header 对齐仍需处理。
- `git diff --check 2f56af2..HEAD -- rhinestone-studio/src`：通过。engine 行为冻结如上；持久化/服务开窗不得泛化为任意文件变更，需以 `projectFile`、`documentService`、`gemdocLifecycle`、`quickLayout` 及注释同步文件的逐文件清单交付。

### 证据分层

`walkthrough-r3` 的 PNG 像素检查、空画幅拦截、重命名聚焦、⌥ 旋转和 B15 入口是 supplied walkthrough evidence；本轮独立测试只证明决策核、调用链和状态回归。两者不得合并表述为独立浏览器验收。

## P2 与已知债

- P2：blocks 四邻 label-map 算法在画布和 PNG 完整复制，已直接促成 P1-1，建议抽共享 helper；service 层再次按 `layer.visible` 过滤也有语义重复风险。
- P2：jsdom canvas 警告与真实浏览器 transform/PNG 证据边界需在 release receipt 中显式保留。
- 不计新发现：重命名预填未全选、seed 平坦剪影、`templatesStore` 负载 flake、`add-designer-selection-paths` 预留、P2-5 图层疑点等既有债；按用户要求不重新打开。

## 评分与裁决

| Change | 分数 | 依据 |
|---|---:|---|
| `redesign-designer-workbench` | 7.7 | 主体实现与护栏可解释，但 9.2/9.2b/9.3 未闭环，不能按全完成归档。 |
| `rework-designer-manual-rhinestone` | 7.4 | 交互、brush、键盘和接线质量高；PNG 边界 P1 与真实浏览器证据缺口直接影响终审。 |
| `enforce-lab-prompt-wysiwyg` | 8.3 | 实现同源和 byteEq 方向正确，但缺 delta spec，严格契约无法验证。 |
| **综合** | **7.8** | 无 P0，三项 P1 均可复现且有明确修复路径；修复并补齐证据后可进入 GO 重审。 |

**最终裁决：NEEDS-WORK。**

---

## 重审（R2）

重审基于当前 HEAD `181b0d13e187a00c596c9fed1675ece67c94c9c2`，并按原报告三项 P1 的“可验证修复”逐项复核。只追加本节，不改源码或其他 change 文档。

### P1-1 复核：通过

- `d15bbf0` 新增 `rhinestone-studio/src/lib/designer/blockOutline.ts`，提供 `buildBlockLabelMap`、`isBlockBoundaryAt`、`paintBlockOutlinePixels` 三个单源 helper；`pngRender.ts:225` 与 `DesignerCanvas.svelte:257` 均收敛为一行消费，不再复制 label-map/四邻算法。
- `isBlockBoundaryAt` 在 `gx <= 0`、`gx + 1 >= W`、`gy <= 0`、`gy + 1 >= H` 时把越界邻居恒判为非本块，直接满足原报告的修复条件。
- 独立运行：
  `pnpm exec vitest run src/tests/designer/blockOutline.test.ts src/tests/designer/pngRender.test.ts`
  结果 `2 files / 12 tests passed`，exit 0。新增断言覆盖满宽中间行左右边、满高上下边、相邻行内容不漂移、helper 四向守卫、DesignerCanvas 消费面及 PNG 消费面四边中点。
- 结论：P1-1 关闭。原 P2 重复算法建议也随 helper 抽取一并关闭。仍保留真实浏览器像素走查属于 Owner deferred 层的证据边界，不把 jsdom/recording canvas 当作浏览器 E2E。

### P1-2 复核：通过（按显式 deferred 口径）

- `181b0d1` 将 `tasks.md:81-82` 的 9.2、9.2b 勾选，并回填 walkthrough-r1/r2/r3 证据；9.3 保持未勾，但在 `tasks.md:83` 明确标注“非阻塞⑤·Owner 验收项·deferred”。
- 新增 `redesign-designer-workbench/COMPLETION.md`，明确三层证据：独立 jsdom 决策核、supplied vision walkthrough、Owner 9.3 待验；文件明确禁止把三层合并表述为独立浏览器验收。
- 这与原报告提出的二选一修复路径中的第二条一致：9.3 不再伪装为已完成，而是有责任边界、四项验收内容和非阻塞归档口径。该 change 的“全部实现交付”声明现在与 tasks/COMPLETION 的 deferred 口径一致。
- 结论：P1-2 关闭；9.3 仍是明确的 Owner 后续验收风险，不计为当前 implementation blocker。

### P1-3 复核：通过

- `181b0d1` 新增 `openspec/changes/enforce-lab-prompt-wysiwyg/specs/prompt-lab/spec.md`，包含 ADDED requirement 与四个 `#### Scenario`：byteEq 公理、图序进入案例片段、规则入 seed 且改过不重播、预览与发送同源。
- `add-designer-selection-paths/.openspec.yaml` 新增 `skip_specs: true`，与其“预留占位、未立项实施”的 proposal 口径一致。
- 独立运行 `openspec validate --strict --changes`：`14 passed, 1 failed`；目标 `enforce-lab-prompt-wysiwyg` 已通过，`add-designer-selection-paths` 也已通过。唯一失败为既存 `add-manual-edit-mode` 无 delta 的僵尸 change，非本次三个 change 的新问题。
- 结论：P1-3 关闭。归档总门仍需单独清理 `add-manual-edit-mode`，但不阻断本次三 change 的实现 GO。

### R2 全量护栏与证据

- 独立 `pnpm check`：`svelte-check found 0 errors and 0 warnings`。
- 独立 `pnpm test`：`167 passed` test files，`2054 tests passed | 1 skipped`，exit 0。输出仍有 jsdom canvas `getContext()` 未安装的非失败提示；这不改变 helper/决策核结论，也不升级为真实浏览器证据。
- `git diff --check e7484da..HEAD -- rhinestone-studio/src openspec/changes`：通过；engine 冻结例外未扩大。`git diff --stat 2f56af2..HEAD -- rhinestone-studio/src/lib/engine` 仍仅三处术语注释，未见行为变更。
- 当前 workspace 仅有本报告和用户原有未跟踪 JPG；未改源码或其他 change 文档。

### R2 评分与最终裁决

| Change | R1 | R2 | 复核依据 |
|---|---:|---:|---|
| `redesign-designer-workbench` | 7.7 | **9.1** | 9.2/9.2b 已有可追溯证据，9.3 明确 deferred 且不阻塞；engine/开窗护栏保持。 |
| `rework-designer-manual-rhinestone` | 7.4 | **9.4** | blocks helper 单源化、12 个边界/消费面测试通过；transform/PNG 真浏览器证据仍按 Owner 层分级。 |
| `enforce-lab-prompt-wysiwyg` | 8.3 | **9.5** | delta requirement 四场景已被 strict validator 接受，byteEq/preview/send/seed 实现与契约同源。 |
| **综合** | **7.8** | **9.3** | 三项 P1 均已按可验证标准关闭；唯一 strict 失败是范围外既存僵尸 change。 |

**最终裁决：GO（实现终审）。**

归档说明：三 change 可判 implementation GO；全仓 strict OpenSpec 归档门仍为 `CONDITIONAL`，直到 Owner 清理 `add-manual-edit-mode`。9.3 的 pointer capture、原生 contextmenu、图层拖排与移动端断点仍是 Owner deferred 验收项，不能在后续材料中宣称已独立验收。
