<!--
Orthogonal intents (max 5):
1. [2026-09-18 User objective] 用户在前端直接改提示词变体、分组生成候选、立刻预览。
2. [2026-09-18 Network] BYOK 纯前端直连，凭据永不离开浏览器，网络层对中转站差异鲁棒。
3. [2026-09-18 Reliability] 生成任务可取消、可重试、可恢复，持久化有配额降级。
-->

## Purpose

定义从原图到"贴钻层数字油画"候选的生成工作流：提示词变体管理、并发生成、分组展示与预览、以及 BYOK 网络层的可观察行为。

## ADDED Requirements

### Requirement: BYOK 连接配置

系统 SHALL 允许用户配置任意 OpenAI 兼容 baseUrl、apiKey 与模型名（自由文本），并仅持久化于浏览器 localStorage。构建产物中 SHALL NOT 内联任何 apiKey。

#### Scenario: 中转站 baseUrl

- **WHEN** 用户填入非官方的中转站 baseUrl 并生成
- **THEN** 请求发往该 baseUrl 对应的 `/images/generations` 或 `/images/edits`，响应同时兼容 `data[0].url` 与 `data[0].b64_json`

#### Scenario: 连接测试

- **WHEN** 用户点击连接测试
- **THEN** 系统向 `{baseUrl}/models` 发起 GET 并展示可达性结果，失败时区分网络错误与鉴权错误

### Requirement: 提示词变体组生成

系统 SHALL 支持编辑一组提示词变体（默认 5 组、每组候选数默认 2，均可增删改），并对每个"变体 × 候选"发起独立的单图生成请求（请求体 `n` 恒为 1），以可配置并发上限并行执行。

#### Scenario: 分组批量生成

- **WHEN** 用户上传参考图并对 3 个变体各设 2 候选发起生成
- **THEN** 系统发出 6 个独立请求，画廊按变体分组展示 6 张候选，每组内含各自的状态/耗时/错误信息

#### Scenario: 单候选失败重试

- **WHEN** 某候选请求失败且用户点击重试
- **THEN** 仅该候选重新发起请求，输入的参考图无需重新上传，其余候选不受影响

### Requirement: 高级参数逃生舱

系统 SHALL 提供 Advanced JSON 输入，其内容合并进请求体原样透传（含 `background: "transparent"`、`quality`、`seed` 等），不做白名单校验；upstream 报错 SHALL 原样展示给用户。

#### Scenario: 透明背景参数

- **WHEN** 用户在 Advanced JSON 填入 `{"background":"transparent","output_format":"png"}` 并生成
- **THEN** 请求体包含这两个字段；若端点不支持，错误信息原样展示且不重试

### Requirement: 候选预览与送转化

系统 SHALL 提供候选的放大预览，支持与原图的叠加模式（透明度可调）与并排模式；任一候选 SHALL 可一键送入转化工作台作为输入。

#### Scenario: 叠加比对

- **WHEN** 用户打开某候选的叠加预览并拖动透明度滑杆
- **THEN** 候选图与上传原图实时混合显示，用于判断风格化选择的偏差

### Requirement: 持久化与配额降级

生成图片 SHALL 写入 IndexedDB；任务与设置 SHALL 写入 localStorage，且在配额不足时按"全量 → 去 payload → 仅最近 50 条"三级降级，任何情况下 SHALL NOT 因配额异常丢失设置。

#### Scenario: 刷新恢复

- **WHEN** 用户刷新页面后回到实验室
- **THEN** 历史候选从 IndexedDB 恢复显示，BYOK 设置保持
