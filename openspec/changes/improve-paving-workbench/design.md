# design — improve-paving-workbench

## 0. 裁决登记（均标可推翻；Owner 原话见 proposal）

| # | 裁决 | 出处 |
|---|------|------|
| D1 | 二级图层 = 区块（`#No`）；树为视图层派生，归属真源仍是 `LayerRecord.blockIds`；rest 兜底层下块同样显示 | Owner 点 1/5 + 主会话冻结 |
| D2 | 画布选中块 = 选中其二级图层行，反之亦然 | 主会话冻结 |
| D3 | 一级拖动排序仅视觉序/层序；联合计算/编号/BOM 顺序固定按层 id 稳定序（「层排序不改变几何与 BOM 顺序」纪律） | 主会话冻结 |
| D4 | 块级「继承」开关（显式）：开=跟随一级（只读+「继承中」）；关=独立微调策略+基础规格；关→开独立配置休眠保留、再关恢复；首次关闭以父层当前配置快照为起点 | Owner 修订原话 2026-09-20（替换早先「一经修改即脱离」隐式裁决） |
| D5 | 历史 = PS 游标模型：undo/redo 只动游标，列表恒定；游标非尾新操作截断前向 | Owner 点 2（参考 PS） |
| D6 | 0% 密度 = 无钻合法状态，排除口径同禁用块（不参与排布/预估/统计/导出门输入）；engine/persistence 值域 (0,1] 不动 | Owner 点 3 + 主会话冻结 |
| D7 | 改名只动代码面；TERMS/PRODUCT_MODEL 留主会话 | 主会话冻结 |
| D8 | 二级图层模型将复用于设计师工作台（见 redesign-designer-workbench 封存稿） | 主会话注记 |

## 1. 二级图层树 + 拖动排序 + 移入修复

```
LayerPanel（左列，role=tree 语义）
├─ 一级行 [眼睛][≡ 拖柄][层名 双击重命名][钻数][状态点][⋯菜单(重命名/合并/删除)]
│   └─ 折叠钮 ▸/▾ → 子行 [色点][#No label][钻数][独立徽标「独」]   ← 二级图层 = 成员块
├─ …（rest 兜底层行同样可展开）
└─ 背景层钉底行（不变）
```

- 子行点击 = `selectBlock(b.id)`（既有两级联动隐式选中所属层）；画布点选块 → `selectedBlockId` 变化 → 面板子行高亮 + 父层自动展开（D2 双向同步的最小实现：状态单源已有，只补 UI 派生）。
- **拖动排序**：HTML5 DnD（一级行互拖，dragstart/dragover/drop），落位 = `dispatchStudioOp({t:'layer.reorder', order})`（order = 全量层 id 序列）。reducer `applyLayerReorder`：order 为当前层 id 集合的排列才应用，否则诊断 no-op（fold 跨结构变更的 stale 容错）。历史可撤销、随 layers[] 声明序入档。
- **联合口径稳定序**：`jointViewOf` 由「数组序」改为「层 id 字典序」——现状两序恒等（无重排 op），行为零变化；引入重排后联合编号/导出/BOM 不随面板序漂移（D3）。
- **移入图层修复**：现状 BUG = `layer.moveBlocks` dispatch 后无人标脏（computeQueue 只监听 replay 事件）→ 画布结果停留旧归属。修复 = store 根新增 `moveBlockToLayer(blockId, toLayerId)`：记 prevOwner → dispatch → `markLayersDirty([prevOwner.id, toLayerId], immediate)`。LayerPanel 的 merge/create/delete 同补标脏（同族缺陷一并修）。入口标签 = `owningLayerOf(selected).name` →「移入图层 · 当前：图层N」；菜单禁用态按真实归属（现状 rest 层按钮恒可点 = 归属判定错误）。
- 「块列表」折叠组从 Inspector 删除，`BlockList.svelte` 退役（死 API grep 清零）；其「无鼠标辅助列表」职能由树子行承接（点击选中）。

## 2. 历史 PS 游标模型（history.svelte.ts）

```
状态: baseSnapshot + ops[](恒追加只截前向) + cursor ∈ [0, ops.length]
       state = fold(base, ops[0..cursor))

undo: cursor>0 → cursor--; refold; emit(replay)      // 列表不变
redo: cursor<len → op=ops[cursor]; cursor++; refold   // 列表不变
dispatch: ops 截断到 cursor → push/合组 → cursor=ops.length
          （「强行修改 → 前向记录被覆盖」= Owner 点 2 原语义）
压实: 仅 dispatch 触发（此刻 cursor≡尾），drop 最旧后 cursor 同步减 drop
```

- `canUndo = cursor>0`；`canRedo = cursor<ops.length`；`getUndoDepth() = cursor`；新增 `getHistoryCursor()`（面板灰显数据面）。
- HistoryPanel：全列表恒渲染；下标 ≥ cursor 的行灰显只读（`opacity-50` + 「已撤销」title）；当前态行（cursor-1）高亮。redoBuffer 删除（前向条目就在 ops 里）。
- 合组（coalesce）只发生在 cursor≡尾的 dispatch——重写末位 op 语义不变。跨重分块 undo（segment 回旧 k/seed 确定性重放）、诊断流、dirty 全集、「栈永不序列化」全部保持。

## 3. 块级「继承」开关 + 独立计算单元

数据（LayerState.overrides 第五表，会话态）：

```
overrides.config: Record<blockId, { inherit: boolean; strategy: StrategyId; specKey: string }>
  写入时机：仅触碰开关/独立编辑时创建条目（未触碰 = 无键 = 继承，兼容旧态）
  开关关（首次）：条目 = { inherit:false, ...父层当前 strategy/specKey 快照 }
  开关关（再关）：恢复休眠条目原值（不重摄快照）
  开关开：{ inherit:true, ...休眠值保留 }
```

- 有效配置解析：`effectiveBlockConfig(layer, blockId) = 有键且 !inherit ? 键值 : (layer.strategy, layer.physics.specKey)`。
- 计算（computeQueue）：脏层解析后按 config 表分裂——继承块留在层批（现状路径）；每个独立块生成合成单元记录 `{id:'${layerId}#${blockId}', blockIds:[blockId], strategy, physics:{...层物理, specKey}, overrides:单键子集}`，二次 `resolveLayerPlans` 解析（custom specKey missing 四态 → 该单元 error entry，隔离同层）后入同一 `LayerComputeSession` 批。结果键 = 合成 id；`jointViewOf` 合并父层 + 其独立子单元（warnings/dropped/hasError 聚合）；`layerComputeStatus` 感知子单元 error。toggle/config 写入 → 层签名变化 → 标脏重分裂（live 路径由 mutator 显式标脏）。
- 继承/独立可证行为（测试义务）：继承块随父层配置变（父层改策略/规格 → 块结果变）；独立块不随（父层改 → 块结果不变）；开关双向切换休眠恢复 + 快照起点（D4）。
- op 面：`block.override` 扩两 patch —— `{kind:'inherit', value:boolean}` 与 `{kind:'config', value:{strategy,specKey}}`（仅独立态可写，UI 只读兜底）。canonicalParamStateJson/paramStateHash 纳入 config 表（fold 等价断言面）。
- 序列化：`toLayerRecord` 剥离 config 表（LayerRecord 冻结 + persistence 禁改）→ **独立配置为会话态，保存/重开回落继承**（v3 登记项，见 §6）。

## 4. 密度 0% = 无钻排除（D6）

```
UI: 块/层密度滑杆 min 0%（clampDensity 下界 0.01 → 0）
派生: effectiveBlocks 过滤「生效密度 === 0」的块（块覆写 ?? 层密度）→ 不入 layout 输入
      densitySpec/密度 Record 跳过 0 键 → engine zod unit(0,1] 恒不触 0
统计: estimateCount(density=0) = 0 预估；导出门 blocks 与统计口径自动一致（同 effectiveBlocks）
持久化: assembleInput（保存组装，lib/studio 域）投影——
      块覆写 0 → disabled 标记（无钻意图精确往返，重开后面板显「已禁用」）
      层 density 0 → physics.density 序列化 0.01 + 当前继承成员投影为 disabled
      （新块重分块后按 1% 继承 = 已知降级，v3 值域 [0,1] 扩展登记）
```

- 「建议 填充」badge（BlockDetail 头行）删除——全库 UI「建议」提示 grep 清零收据（注释/文档中的「建议」措辞不在范围）。

## 5. 改名映射（代码面，D7）

| 旧 | 新 | 位置 |
|----|----|------|
| 排钻设计（桌面 Tab） | 排钻工作台 | App.svelte Tabs.Trigger（唯一 App 改动） |
| 已送入排钻设计 | 已送入排钻工作台 | gallery/lab store toast |
| 与排钻设计参数隔离 | 与排钻工作台参数隔离 | StudioStatusBar toast |
| 去排钻设计送精修 | 去排钻工作台送精修 | EditView 空态引导 |
| 注释/测试断言中的「排钻设计」 | 排钻工作台 | 全库 grep |

- 移动端 Tab「排钻」保留；TERMS.md/PRODUCT_MODEL.md 及其契约测试（modelDocs.test.ts 断言「排钻设计 · 图层域」）不动——主会话登记后另行收口。
- Lab/Assets 域文件（lab.svelte.ts / gallery.svelte.ts / TaskCard.svelte / AssetsView）只改一行级文案；遇并行代理脏文件：30s 重试，持续阻塞则缓期并回报清单。

## 6. 显式边界与已知降级（v3 登记项，主会话裁决）

1. gemproj v2 值域 (0,1]（projectFile expectUnitNumber）与 LayerRecord 四表冻结 → 密度 0 与块级独立配置**不入档**（§3/§4 降级策略）；v3 = 密度值域 [0,1] + overrides.config 表。
2. 二级图层独立微调范围 = 排钻策略 + 基础规格（gap/松弛留层级；密度已有块级覆写通道）。
3. 历史面板灰显条目不可点击跳转（PS 亦无此交互；点击游标跳转留 P2）。

## 7. 测试与验证策略

- 每切片聚焦 solo（`pnpm exec vitest run <file>`）→ 显式路径 commit；红 solo 复跑定性再判。
- 新增测试义务：树渲染/双向选中（panels）、reorder op + 联合稳定序（layers/computeQueue）、moveBlockToLayer 双层标脏（interactions）、游标模型全矩阵（history：列表恒定/截断/合组/压实/跨重分块）、继承开关两态 + 休眠 + 快照起点（layers + computeQueue 行为证明）、密度 0 排除 + 保存投影（layers/projectPersistence）、「建议」清零与改名 grep 收据（脚本断言或人工收据）。
- 既有 oracle/逐位相等护栏：computeLayer oracle 不触（计算内核不动）；受模型演进影响的断言（history 深度语义、panels 结构、min=1 密度）为显式更新并在 commit 收据注明。
- 回归面：tests/studio 全族 + app.smoke + edit 交接面（lifecycle/editUnbound）+ `pnpm check` 0 错。不跑全量。

> 〔2026-09-21 主会话补注〕D8「二级图层模型可复用于设计师工作台」口径明确：**概念与 UI 形态复用，数据结构不复用**（设计师侧为对象模型 gem.layerId，排钻侧为参数模型 blockIds——见 redesign-designer-workbench design §7-D8 复用口径）。
