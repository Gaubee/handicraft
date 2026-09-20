<!--
Orthogonal intents (max 5):
1. [2026-09-20 Owner 定调] 任何参数输入都是提示词的一部分：三正交效果开关（案例参照图/
   水钻参数配置/蓝图效果）× 占位符注入（【…提示词】全角方括号记号）× 片段双态（auto/override）。
2. [2026-09-20 Semantics] 开+占位符=原文替换；开+缺占位符=不注入+发起面板提示（不静默追加，
   段尾自动注入退役）；关=占位符原样保留。三开关全关+无占位符=输出逐字节=现状（红线）。
3. [2026-09-20 Schema] .gemtpl v2 可选键 caseRef/promptFragment（不 bump 版本；caseRef 缺席+
   有绑定 → 读面视为开）；.gemgen provenance fragmentSources 审计键。
4. [2026-09-20 Refresh] v2 预设增量 seed（ast-tpl-<id>-v2，复用 v1 合成图）；未修改旧内置软删
   （最小口径：promptBody 逐字节==preset && candidates==2 && 绑定在 && v2 键全缺席）。
5. [2026-09-20 Rename] UI 全域「参考图/参考原图」→「原图」（TERMS v4）；模型面骨架常量与
   byteEq 快照冻结不改（红线优先）。
约束：每切片 solo vitest 绿 + 显式路径 commit（repo 根发起，禁 amend）；收尾 svelte-check 0 错
+ lab 全族/assets labFile 族/app.smoke 回归；不起 dev server。
-->

## 1. 切片 1：schema（labFile.ts + round-trip）

- [x] 1.1 .gemtpl v2 可选键：`caseRef?: {enabled, promptFragment?}`、`drillParams.promptFragment?`、`blueprint.promptFragment?`（serialize/parse 双侧校验 + 键序确定；脏输入 typed error）；.gemgen provenance 可选 `fragmentSources`；vitest：round-trip 字节等价 + 缺席键零漂移 + 脏输入（caseRef.enabled 非 boolean / promptFragment 非 string / fragmentSources 非法枚举）

## 2. 切片 2：组装引擎（prompt.ts substitution + composeDrillPrompt 消费）

- [x] 2.1 占位符常量 + `substituteEffectPromptPlaceholders` 纯函数 + composeDrillPrompt 扩展（casePromptFragment/blueprintPrompt options + drillParams.promptFragment ride-through + 段尾 specSection 退役 + SEGMENT_ORDER_MAIN 注记）；effectRefs 骨架注释同步；vitest：替换矩阵 + 红线（三开关全关+无占位符逐字节==旧输出）+ 既有 drillParams 注入测试改造为占位符口径

## 3. 切片 3：UI（三开关 + Dialog + 插入 + 发起提示）

- [x] 3.1 templates store：TemplateRecord/patch/clone/快照扩展（caseRef + 三 promptFragment）+ 读面归一（caseRef 缺席+绑定 → 开）；vitest：字段提交/关灯不丢数据/读面兼容
- [x] 3.2 EffectPromptDialog 组件 + TemplateAdvancedOptions 三开关改造（铅笔 icon button + 案例段收纳 EffectRefControl）+ TemplateEditor 光标插入回调；vitest：Dialog 三 action（保存/取消/插入幂等）+ 案例开关门控选图面
- [x] 3.3 RunBar 占位符缺失派生提示 + startRun 快照扩展（casePromptFragment/pendingDrill.fragment/blueprint.fragment + 案例开关 → effectRef）+ runStage 组装消费 + gemgen fragmentSources 归档；vitest：缺失提示矩阵 + 端到端组装（开+占位符替换进请求提示词）

## 4. 切片 4：模板刷新（v2 预设 + 旧内置软删）

- [x] 4.1 v2 预设文案表（presets）+ seedBuiltinTemplates v2 增量（ast-tpl-<id>-v2，复用 v1 合成图，caseRef enabled）+ retireUnmodifiedBuiltinTemplates（最小口径 + v2 存在安全门）+ hydrate 接线；vitest：增量 create-only/软删判定矩阵（未修改删/修改留/用户模板零触碰/v2 失败不删）

## 5. 切片 5：改名（参考图 → 原图）

- [x] 5.1 UI 全域改名（lab/studio/edit/assets 文案+注释+测试断言；蓝图参考图与模型面骨架除外）+ TERMS v4（词条改名+版本注+案例参照图词条补功能开关语义）；vitest：源码扫描无残留（白名单：prompt 骨架常量/TERMS/快照测试文件）

## 6. 收尾

- [x] 6.1 `pnpm check` 0 错 + lab 全族 + assets labFile 族 + app.smoke 回归全绿；红 solo 复跑定性；grep 收据（改名清零 + 例外清单）落报告
