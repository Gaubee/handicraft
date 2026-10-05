# 参考图层旗舰重跑（ref-layer-flagship · 2026-10-05 · 自动生成路径产品内首跑）

> 起因：Owner 判 T7a 分享包 aXMPb8THHBcP「效果很差」并质询「我要求的辅助图层呢」——此前
> image-edit 未配置，全部产物都是原图软回退分件。Owner 随即给出本地服务配置
> （http://127.0.0.1:20002/openai-image/v1 · gpt-image-2.5 · 免密钥），本批完成配置落位
> （settings 真源+免密钥放宽）并真实跑通自动生成全链。
> 会话 `e090f309-a108-4234-876b-bac01e397a00`；四幕：首跑 160df9a7 → 续跑 da43f63f →
> 解卡重建 daf94d33（废案）→ 终局收口 f92a04c5（交付）。

## 幕一·首跑（160df9a7，77min 熔断）——参考图层全链铁证

| 环节 | 证据 |
|---|---|
| JPEG 直传 | 原版微信 JPG 274101B（run1 死链同字节）→ 归一 `4d9eddcf`（1280×1280 PNG） |
| S2 风格 | style=**photographic**（scene-analysis.json） |
| 参考图层生成 | **本地 gpt-image-2.5**（provider=local-image-edit，免密钥）；服务端 1254→500 网格对齐 |
| 一致性门 | **IoU 0.912 ≥ 0.85 过**（srcCov 0.829 / refCov 0.776；report 工件 provider=local-image-edit） |
| 分件真源 | 树 37 版全部锚 `09ee4adc`（参考图层），500×500 规范网格，精修至 v37 |
| 熔断点 | strategy.design：文本网关连续 **9×300s 顶满不返回** → RUNAWAY_LIMIT=5 同错熔断，任务 failed |

**诊断**：每次调用精确 300s 被 daemon 侧掐断（activity durationMs 实测 286-300s）——GLM-5.3-Flash
网关（20002/anthropic）对该规模 prompt（31 节点+992 候选上下文）当时不返回；挂账 P2「供应商
稳定性」升级为整跑杀手的新实证。
**对策**：`STRATEGY_DESIGN_LLM_TIMEOUT_MS=600000` 入 start-8317.sh + 重启。

## 幕二·续跑（da43f63f，9min 纪律收口）

agent 未瞎重跑：核查无死锁授权残留 → mofang 100 款入 manifest → 卡点如实上报（旧树工件引用
在其只读面查不到；不肯换入参作废断点、不肯瞎猜画布尺寸）。**优秀纪律样本**。

## 幕三·解卡重建（daf94d33，40min）——废案教训

喂入 treeArtifactRef（cb323423 v37 终树）+sceneAnalysisRef+canvasCm 后：方案 1（旧树直挂）
被 `artifact-task-mismatch` 跨任务栅栏硬拒 → 方案 2 以同入参重建分件。**关键失误链**：参考图层
是任务域工件——新任务无参考图层帧 → 分件回退原图（树锚 `c81d0e53`≠`09ee4adc`）→ 产出
`/r/X1XKrl6YAWtr`（642 颗）**仍是原图分件质量，不可当参考图层交付**（右天使脸部 4 种手段零实例
等原图特征性困难全数复现）。

## 幕四·终局收口（f92a04c5，54min）——交付

发现 failed≠cancelled 任务可写（writer-fence 只拒 cancelled/删行/会话非活跃），但
**approved-mutation 的 grant 只在运行时绑定任务上签发可消费**（旧任务上 3 次 propose 全
grant-expired）→ agent 自解：「工具上下文用绑定任务 + 旧树工件经 treeArtifactRef 显式锚定」
一次打通（金丝雀 stones.add → 策略 → 排钻 → 导出）。

**交付物：`/r/CIEFA73NChu4`**（resultId cd507941）
- 936 颗 / 27 分件 / BOM 9 行：夜空 235、三袍裙 348、卷发 90、羽翼 48、花环 41、花篮 90、六星 22
- 树=**v37 参考图层树**（cb323423，锚 09ee4adc）零重建；导出 bundle 含源图 `4d9eddcf`（归一原图）
- 归属门披露 3 缺口（右翼主羽 100%/星星·右上 98.6%/左翼下羽 90.1% 被夜空掩膜覆盖——v37 固有
  兄弟重叠审计面）；夜空 7 组孤立钻组；4 小星 hex-pitch 兜底
- 用钻=「三天使圣诞·智能选钻盘」34 款组合（mofang 100 款无尺寸被引擎硬拒——数据治理挂账强化）

## 产品缺口新证（本轮暴露，待立项）

1. **跨任务树引用栅栏**：同会话内 fail-then-resume 场景，v37 树锁死在失败任务——grant 绑定+
   artifact-task-mismatch 双重卡点，agent 靠 treeArtifactRef 锚定绕行（非正规军路径）。
   断点续跑的「续」在任务域模型下对树/参考图层不成立。
2. **参考图层任务域**：每 followup=新任务 → 参考图层/树/manifest 全部断档；会话级资产或
   树领养机制待议。
3. GLM-5.3-Flash 网关大规模 prompt 9×300s 零返回（600s 后单次通过——幕四 26 次策略调用成功）。

## 产物索引

- 幕一档案：`../jpeg-live-regression/`（配置脚本 configure-image-edit.mjs 亦在此目录）
- 本目录：run.mjs / resume.mjs / unblock.mjs / finish-on-original.mjs / create-result.json /
  resume-result.json（四幕任务 id 链）
- 会话验收入口：`http://127.0.0.1:8317/#/t/e090f309-a108-4234-876b-bac01e397a00`
- 交付分享包：`http://127.0.0.1:8317/r/CIEFA73NChu4`；对照（原图分件·Owner 判差）`/r/aXMPb8THHBcP`；
  废案 `/r/X1XKrl6YAWtr`
