# JPEG 直传 live 回归（补证①·codex-final-r1 需修清单第 1 条）

> 2026-10-05 · daemon HEAD **159d72c**（PID 80133，8317）· 会话 `ef497520-8afe-403d-81e8-0f2883f8628c` · 任务 `27c4f7f0-9432-4edf-b3f6-e7fcb1cf92ce`
> 对照：run1（ba20c68 修复前）同字节直传 → scene_analyze/subject_segment/pave-preview 三面 `image-decode-failed` 死链，agent 6.3min 零分件诚实终报。

## 跑法

`run.mjs`：匿名 token → `assets.upload`（**原版微信 JPG 274101B，与 run1 逐字节同一文件**）→ `session.followup`（轻指令：只做一次 scene_analyze 即止；autoApprove=true）。全程只观察；`verify.py` 只读取证（DB mode=ro）。

## 结果：12/12 PASS（verify-result.json）

| # | 断言 | 结果 |
|---|---|---|
| 1 | 全帧流零 `image-decode-failed` | PASS（run1 死链面根治） |
| 2 | scene.analyze 入参=归一 ref `4d9eddcf…`（≠上传 JPEG ref `627d3260…`） | PASS |
| 3 | 归一 blob 本体：PNG 魔数+1280×1280（sharp 转码+无 EXIF 旋转） | PASS |
| 4 | 原 JPEG blob 在库（内容库保留原字节=审计真源） | PASS |
| 5 | tasks.params 含归一 ref | PASS |
| 6 | tasks.params **零** JPEG ref（设计=无 ref 双源） | PASS |
| 7 | 帧流（会话可见面）零 JPEG ref 引用 | PASS |
| 8 | intake-image.png 工件在场（工作画布锚点） | PASS |
| 9 | scene-analysis.json 工件在场（S2 真跑通——run1 死在这步） | PASS |
| 10 | style=photographic（与 run2 同图判定一致） | PASS |
| 11 | 任务终态 done（~2min，轻指令闭环） | PASS |
| 12 | assistant 终报在场 | PASS |

## 归一链结论

上传面真单一真源成立：任何入口（UI/RPC 直传）的 JPEG/WebP 经 followup 单漏斗归一为新 PNG blob，**prompt 锚注 / tasks.params 审计 / 帧流 / 工件 / 后续视觉管线全链只见归一 ref**；导出 source 门（T5 5.1 字节级断言：source.img=会话主图集附件）消费同一主图 ref——本跑证明该 ref 恒为归一 PNG，闭合「session/task/export 全链只引用归一 ref」。

## 残留边界（与终审口径一致）

- UI 客户端 `convertImageToPng`（W5 P0-2）仍在——职责=上传预转换优化（省带宽/旧兼容），服务端归一=权威单源；两侧共同不变量「会话附件恒 PNG」已有双向测试（client 转换测试 + 服务端 PNG 直通零变化测试）。补证④已将其职责显式化（注释声明，零行为变更）。
