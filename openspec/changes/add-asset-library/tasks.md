<!--
Orthogonal intents (max 4):
1. [2026-09-19 Delivery] Codex-R1 修订版：契约冻结（解析出口/双图 effectRef/controller/引用集/IDB opener）→
   fake IDB 扩展 + 纵向 tracer bullet → assetStore/迁移 → UI → 三模块接入（R1 §C 四步顺序的前两步）。
2. [2026-09-19 Safety] 迁移幂等/环检测/软删递归/引用保护全集/资产不可变全部 vitest 证明；真实刷新序列与四类引用各配用例。
3. [2026-09-19 Contract] 与 redesign-studio-layout 的共享适配层（getAssetBlob/controller/handoff v2）先冻；
   其布局骨架可并行，资产接入等本 change 适配层就绪（不复制临时 picker）。
4. [2026-09-19 Process] 每步绿门：pnpm test + svelte-check + build；浏览器走查按 PM §5 验证计划 5 条。
-->

## 0. 测试能力与纵向链路（GO 前置）[Codex-R1-B4/C]

- [ ] 0.1 fake IDB 扩展：多 objectStore / version upgrade（oldVersion→2）/ index 查询 / 事务 / 中途失败注入；或经评审裁定的等价真实 IDB 方案
- [ ] 0.2 纵向 tracer bullet（后续任务的地基与 GO 验收）：上传 → 生成（stub）→ 刷新（reset+hydrate）→ 选图 → 送转化 → 送精修 → 清理，全链断言（含 missing 分支）

## 1. 数据层（assetStore）

- [ ] 1.1 共享 DB opener + IDB v2 upgrade（assetNodes + 三 index）+ AssetNode 类型与 CRUD；vitest：upgrade 序列、index 查询、节点建/查/改、同父重名自动后缀、系统目录保护
- [ ] 1.2 解析出口冻结 [B1]：getAsset / getAssetBlob / objectUrlForAsset；vitest：blob/external/缺失/软删四态；全库断言无 blobKey(assetId) 式调用方拼 key
- [ ] 1.3 移动/环检测/软删（递归）/清空回收站（递归硬删 + 引用集保护：变体 assetIds + studio 会话 + 活动 EditDocument + task 弱引用）；全部单事务；vitest：移入后代被拒、递归软删原子性、四类引用各自保护/放行
- [ ] 1.4 objectURL LRU 缓存（上限 200，超限 revoke 最旧）；vitest：同 id 复用同 URL、超限回收、releaseObjectUrl
- [ ] 1.5 启动幂等迁移（seed → preset 双图节点 upsert → runId 批次夹 → effectref src/res 配对归上传 → **全步骤成功后置 flag**）；vitest：注入中途失败重跑收敛、跑两次一致、blob 缺失标 missing、旧 v1 数据回读

## 2. 素材库 UI（第四 Tab）

- [ ] 2.1 ViewId 增 'assets' + 第四 Tab；AssetsView：树（系统目录置顶+徽标）+ 网格/列表 + 面包屑 + objectUrlForAsset 渲染
- [ ] 2.2 文件操作：新建/重命名（行内）/移动到…/删除（递归软删确认 N 图 M 夹）/下载/多选；PM §2.6 七态落地（空库/迁移中/blob 缺失/上传失败/重名/移动环/清空遇引用）
- [ ] 2.3 预览 Dialog（大图+meta+动作；案例显 originNote）；移动端：目录 Sheet + 2 列网格 + 长按多选 + 全屏预览
- [ ] 2.4 回收站：计数徽标 + 清空（红色点名确认 + 引用保护明示清单）；底部状态条（共 N/回收站 N/存储估算）

## 3. 选图器与共享适配层（先冻，供布局 change 并行）

- [ ] 3.1 AssetPickerController + AssetPickerHost [B6]：open/resolve/cancel、Esc/外部点击、并发接管（前者 resolve null）、销毁 resolve null、multi 半选清空；**controller 单测先行**，后接 UI（chips 集合/面包屑/网格/上传即入库自动选中）
- [ ] 3.2 各模块 Dropzone/上传按钮保留，handler 改「入库 → 选中」（经 §1.2 出口）

## 4. 实验室接入

- [ ] 4.1 参考原图 asset 化 + PersistedTaskMeta.referenceAssetId [B3]；vitest：真实刷新序列（上传→terminal task→reset→hydrate→retry 成功）+ 缺失资产失效态分支
- [ ] 4.2 效果参考双图契约 [B2]：kind:'asset' assetIds{src?,res}，旧 upload kind 直接删除（[Owner] 无兼容分支；存量 blob 走 §3 一次性迁移）；vitest：src 缺省/res 缺失/preset 版本 upsert/B-2 替换不删资产
- [ ] 4.3 生成结果归档 [议题3 修正]：首个成功懒建批次夹（runId 幂等）+ 空批次清理 + blob/节点/meta 三步补偿（终态持久化时幂等补建）；vitest：中途退出重跑、全失败无残留夹
- [ ] 4.4 清空历史解耦（现 clearHistory 删 blob 路径显式迁移）；vitest：B-1 资产完好
- [ ] 4.5 handoff v2（assetId+name+referenceAssetId；missing 显式出口；[Owner] 直接切换无双写）；vitest：工作台经 getAssetBlob 解码载入、missing 回退空态

## 5. 工作台接入

- [ ] 5.1 空态双 CTA + origin 'library' + StudioImage.assetId；上下文条「更换」经 controller
- [ ] 5.2 参考原图 asset 化（{assetId, dataUrl 缓存}；handoff.referenceAssetId 解析）；vitest：叠原图经资产加载

## 6. 手动编辑接入（C-1/C-2 链路全覆盖 [B5]）

- [ ] 6.1 referenceAssetId 贯通：studio referenceImage → buildManualEditHandoff → EditDocument → **EditCanvas 异步 resolver**（loading/ready/missing/soft-deleted 状态机；切换清理；[Owner] 直接切换无双写）；vitest：烘焙隔离不破坏 + 四态渲染 + add-manual-edit-mode/design.md §1 同步修订
- [ ] 6.2 活动编辑引用入硬清空保护（registry 或自动解除，实现前冻结其一）；vitest：硬清空不删活动文档引用
- [ ] 6.3 导出 PNG 入库 sys-exports + toast；vitest：source/naming

## 7. 收尾

- [ ] 7.1 行为变更 changelog（B-1~B-4）+ 全量绿门
- [ ] 7.2 浏览器走查 PM §5 五条 + §0.2 纵向链路真机复跑
- [ ] 7.3 PRODUCT_MODEL.md 已入库（R1 基线提交）；本 change 归档时同步 specs/
