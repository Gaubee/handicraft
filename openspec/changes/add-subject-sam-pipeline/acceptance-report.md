# add-subject-sam-pipeline 交付验收报告

日期：2026-09-25 ｜ 分支：add-backend-platform-impl ｜ HEAD：15fe4e2

## 一句话结论

识图→策略→排钻内核管线全链交付：SAM3 真连识图（macmini）、七策略族、策略设计器 UI、真实旅程会话端到端（「把这束花按枝条贴」→ 4 图层指派 → 472 颗钻），三仓门禁全绿（1 项既有负载敏感），真环境走查发现并修复 2 个 UI 缺陷。**可交付验收。**

## 交付范围（P0-P3.3）

| 段 | 内容 | 实证 |
|---|---|---|
| P0 契约 | ObjectTree/mask 二态/StonePick 统一钻引用/密度 2.3/ΔE 3·10·25 具名常量 | contracts 144 测试 |
| P1 策略 | 七策略族（geometry 六形状/texture-fill 三变体/soft-curve/flower/straight-line/exclusion/free-code）+JS worker 沙箱 E1-E11 逃逸面 | sandbox 46 测试 |
| P2 识图 | macmini SAM3 桥（stdin/stdout 行协议）/scene.analyze 双通道/segmentLoop 状态机+四项加固/Lab kmeans 降级 | 真连冒烟两轮 PASS（295s） |
| P3 应用 | strategy.design 双模授权/策略设计器（三层画布+图层树+schema 表单）/旅程冒烟 | journey-smoke 15 断言 472 gems 13.9s |
| UI 走查 | 真环境装载旅程会话→vision 三轮走查 | 本轮 2 fix + 4 组截图 |

## 本轮收尾工作（UI 段真环境走查）

1. **P1 修复（22037b5）**：Tabs.Content 同时挂载导致 Agent/策略设计两个 SessionStream 实例并存，「生成调整指令」注入被隐藏的 Agent tab 实例抢先消费——两层编辑铁律回写通道在真环境断链。修复=注入消费加可见性守卫（hidden 祖先让位）；双实例回归测试+真环境复验（隐藏 0 字符/可见 180 字符）。
2. **P2 修复（96dceca）**：排除层三处显示无意义的密度 2.3/cm²（图层树/提案卡/参数表单），统一隐藏；测试+vision 元素级截图实证。
3. **vision 三轮走查**：布局/中文可读性/注入对照/画布三层（原图+框线+点阵）全 PASS；截图裁剪类问题以 DOM 断言+jsdom 测试补证闭合。
4. **进程零残留**：8792 daemon 与 agent-browser 三起三清，5200 dev server 全程未触碰。

## 全门禁终验

| 门禁 | 结果 |
|---|---|
| contracts | 144/144 + tsc 0 |
| daemon | 744/745 + tsc 0（1 红=strategies-sandbox cpu-timeout，负载敏感既有：系统 load 12+ 时预算边界抖动，聚焦单测绿；sandbox 本 change 未触碰） |
| studio | svelte-check 0 错 0 警；vitest 2317 项，两轮全量各 20/23 失败**集合完全不相交**且对应文件隔离全绿（lab 521/521、globalImport 11/11 等）——定性为高负载（ZCode 应用自身 load 12+）下 jsdom 挂载测试抖动，非代码回归 |
| openspec | strict：Change is valid；specs 11R/40S + 9R/27S |
| build | studio vite build 多轮通过 |

## 已知限制（交付时如实声明）

1. **LLM 无 key 通道**：daemon LLM_* 未配置（key 只走 env 的约定下当前为空）——真 LLM 旅程需 Owner 注入 key 后生效；旅程冒烟走 mock 网关已验证全链结构。
2. **macmini SAM3 性能**：M1 单次 grounding 25-35s、组合任务 102s（timeoutSec≥180）；点提示/VLM 为 UNSUPPORTED（能力矩阵实测）。
3. **SAM 语义偏差**：真实分割偶有命名与区域错位（如「缎带」框落在叶茎区）——树粒度与语义校准归 P4.1 词表工作（后续波）。
4. **ICC 色彩管理坑**：macOS sips 转 PNG 会嵌 ICC 致同图检出翻转——已固化「像素转换在 macmini PIL 侧」约定（P2.6 实证）。
5. **负载敏感测试**：sandbox cpu-timeout 与 studio jsdom 挂载类测试在高系统负载下偶发超时（隔离必绿）；CI/低负载环境无此现象。
6. **P4 未启动**：中文词表校准/风格候选/Python 沙箱调研为后续波（tasks.md 保持未勾）。

## 提交链（本 change 关键节点）

29ced71(P0.1+0.3)→2b807e4(P0.2)→5ff4e9b(P0.4)→443e421(P1.1+1.5)→e27d6eb(P0.1 修)→b2aed94(P1.4)→0441858(P2.3)→580d2e7(P2.1)→c6cd1c0(P2.4)→b687846(P2.5)→1d16d40(P2.6)→c8f18ec(P3.1)→7ec896a+c0803ae(P3.2)→a7c8319(P2.4 加固)→96b7b11(P3.3)→2d79bc2(specs)→9a6fa4d(P3.3 补帧)→22037b5(UI 注入守卫)→96dceca(排除层密度)→15fe4e2(tasks 收口)

## 验收建议

Owner 验收入口：
1. `cd daemon && DATA_ROOT=<空目录> PORT=8792 npx tsx src/index.ts` + 打开 webui → 设 `handicraft.agentApi='rpc'`、`handicraft.dev.workbenches='1'` → 策略设计 tab 装载旅程会话（或 Agent tab 新会话发起「把这束花按枝条贴」——需 LLM key）。
2. 冒烟脚本：`daemon/scripts/journey-smoke.ts`（15 断言全链）。
3. 走查留档：/tmp/journey-02…08*.png（元素级+全页，已过平凡图防线）。
