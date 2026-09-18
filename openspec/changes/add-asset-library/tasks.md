<!--
Orthogonal intents (max 4):
1. [2026-09-19 Delivery] 数据层先行（assetStore/迁移独立无 UI 依赖）→ 素材库 UI + 选图器 → 三模块接入收尾（PM §4 顺序）。
2. [2026-09-19 Safety] 迁移幂等/环检测/软删/引用保护/资产不可变全部 vitest 证明；行为变更 B-1~B-4 各配回归用例。
3. [2026-09-19 Contract] 选图器签名与 handoff v2 先冻（redesign-studio-layout 并行依赖）；C-1/C-2 与 add-manual-edit-mode 文档同步修订。
4. [2026-09-19 Process] 每步绿门：pnpm test + svelte-check + build；浏览器走查按 PM §5 验证计划 5 条。
-->

## 1. 数据层（assetStore）

- [ ] 1.1 IDB v2 upgrade（assetNodes store + 三 index，images 不动）+ AssetNode 类型与 CRUD；vitest：节点建/查/改、同父重名自动后缀、系统目录保护（禁删/改名/移动）
- [ ] 1.2 移动/环检测/软删/清空回收站（含引用集扫描跳过并报告）；vitest：移入自身后代被拒、软删后引用 id 仍可解析、清空时被引用资产保留
- [ ] 1.3 objectURL LRU 缓存（上限 200，超限 revoke 最旧）；vitest：同 key 复用同 URL、超限回收
- [ ] 1.4 启动幂等迁移（seed 系统目录 → preset 节点 upsert → 批次文件夹归档 → effectref 归上传 → flag）；vitest：跑两次结果一致、中途失败重跑收敛、blob 缺失节点标 missing

## 2. 素材库 UI（第四 Tab）

- [ ] 2.1 ViewId 增 'assets' + App.svelte 第四 Tab（桌面/移动底部导航 4 项）；AssetsView：树（系统目录置顶+徽标）+ 网格/列表切换 + 面包屑 + objectURL 渲染
- [ ] 2.2 文件操作：新建文件夹/重命名（行内）/移动到…对话框/删除（软删确认）/下载/多选；状态矩阵七态（空库/迁移中/blob 缺失/上传失败/重名/移动环/清空遇引用）按 PM §2.6 落地
- [ ] 2.3 预览 Dialog（大图 + meta + 下载/重命名/移动/删除；案例条目显 originNote）；移动端：目录 Sheet 选择器 + 2 列网格 + 长按多选 + 全屏预览
- [ ] 2.4 回收站：计数徽标 + 清空（红色点名确认 + 引用保护明示）；底部状态条（共 N 项/回收站 N/存储估算）

## 3. 统一选图器（签名冻结后供并行）

- [ ] 3.1 AssetPickerDialog：单/多选、快捷集合 chips（最近=updatedAt 前 24/全部/三来源目录）、面包屑、objectURL 网格、「上传新图片」（入库当前目录→自动选中）；返回 AssetImage[]
- [ ] 3.2 各模块 Dropzone/上传按钮保留（习惯路径），handler 改「入库 → 选中」

## 4. 实验室接入

- [ ] 4.1 参考原图 asset 化（Dropzone 入库 sys-uploads + 从素材库选择；reference={assetId,previewUrl}；生成请求读 blob 路径不变）；vitest：B-4 刷新不再丢失（资产可恢复引用）
- [ ] 4.2 效果参考 kind='asset'（uploadKeys 废弃路径兼容读取）；vitest：B-2 替换变体参考不删资产
- [ ] 4.3 生成结果自动归档（startRun 预建批次文件夹 + 成功建节点带 meta + 任务 meta 增 assetId）；vitest：批次文件夹名/归属正确
- [ ] 4.4 清空历史解耦（只清任务 meta/画廊）；vitest：B-1 资产与 blob 完好
- [ ] 4.5 handoff v2（payload=assetId+name+referenceAssetId；送转化=存库+选中）；vitest：工作台经 blob 解码载入、旧 dataUrl payload 兼容消费一次

## 5. 工作台接入

- [ ] 5.1 空态双 CTA（素材库选择=主/上传=次）+ origin 'library' + StudioImage.assetId；上下文条「更换」接选图器
- [ ] 5.2 参考原图 asset 化（{assetId, dataUrl 渲染缓存}；handoff.referenceAssetId 解析）；vitest：叠原图经资产加载

## 6. 手动编辑接入（C-1/C-2 契约修订）

- [ ] 6.1 ManualEditHandoff.referenceDataUrl → referenceAssetId（types/edit.svelte.ts/buildManualEditHandoff/EditView 三处 + add-manual-edit-mode/design.md §1 同步修订）；vitest：烘焙隔离不破坏（参数变更不回流仍真）
- [ ] 6.2 导出 PNG 入库 sys-exports + toast「在素材库中查看」；vitest：source/naming 正确

## 7. 收尾

- [ ] 7.1 行为变更 changelog（B-1~B-4）+ 全量绿门（pnpm test / svelte-check / build）
- [ ] 7.2 浏览器走查 PM §5 五条：新用户不打开素材库也顺畅 / 跨会话复用昨日图 / 整理（建夹移动回收清空含保护）/ 312px+375px 工作台 / 清空历史后素材完好
- [ ] 7.3 PRODUCT_MODEL.md 纳入版本管理（随本 change 首次提交）
