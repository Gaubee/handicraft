# codex-final-r1 终审结论（2026-10-05 · gpt-6.1-sol xhigh · worktree HEAD 159d72c）

> 三 change 最终评审 + T7a 旗舰证据链独立复算。全文照录（herdr agent read 输出）。
> 回流路径：codex-callback exec_82ef5636。补证处置见文末「增量批」。

## 一、add-flat-aux-segmentation

- 分件自动优先参考图层，陈旧图层回退原图；导出源固定取会话主图集附件。
- 导出前有归属审计与布局抽样，source.img 不从参考图层取。
- task.reference 与工作台三态条目已接线。
- Codex 前五门中，四图引用的四门已闭合。第五门 pavingStyle 只有 full | accent 契约和可选参数，默认值仍未冻结；这是 Owner 裁决位，研发灰度可接受，正式归档不可假定已有默认策略。
- 归属门 v1 的边界很明确：只披露、不阻断。T7a 实际发现 4 条星层被夜空层覆盖的缺口并写入 bundle；这证明审计在线，也证明产品仍可带已知归属风险导出。是否升级为导出阻断必须由 Owner 决定。
- JPEG 修复形成了「服务端 followup 的单一会话归一入口」：normalizeAttachmentsToPng 后续链路只消费归一后的 ref。但 UI 仍保留独立的 convertImageToPng（rhinestone-studio/src/lib/agentApi/rpc.ts:474、rhinestone-studio/src/lib/agentApi/attachments.ts:96）。因此「会话域单入口」成立，「所有入口共享同一字节级转换实现」尚未成立；浏览器上传和直接 RPC 可能得到不同 PNG 字节。
- 任务文档仍有闭合残留：顶层 1.1/1.3/1.4/1.5、6.2、7.1、7.2、7.3 未勾选。源码已有相应部分实现，但旗舰集成、四态回退测试和最终 Owner 交付仍不能宣称完成。关键源码见 daemon/src/kernel/vision/export-audit.ts、daemon/src/kernel/index.ts:716。

## 二、unify-studio-routing

- 08d0f96 的 hash 解析/规范化/写入层、54d35ef 的七项 Studio sweep、643023c 的术语表已落地。当前生产代码中的 history/hash 写入已收编至 router；守卫测试覆盖非 router 文件零直接写入。fc5d859 只是把动态 import 冷启动测试窗口调到 120 秒，不能当作运行时性能或路由行为证据。
- 唯一明确残留是 daemon 分享页文案漂移（http.ts「下载 PNG」），任务中已明确留到后批。因此 Studio 功能可以放行，但整个 change 暂不应标记为无尾项归档。

## 三、T7a 旗舰证据

独立复算 /Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/t7a-flagship/report.md 对应产物：

- scene-analysis.style = photographic
- scene/tree/layout 均为 500×500、20×20cm
- 树 36 节点，布局 1172 颗钻，partCounts 合计同为 1172
- 归属缺口 4 条
- 对齐抽样 200，异常 0
- source.img 为 2,984,658 bytes，SHA-256 为 6267829d311a27ee098b248f61bcb8afe31db0cfdcf76039a4453d4184aba5b9；bundle source、audit source 和文件字节一致

这些是可信的产物级证据。以下仍属于报告/agent 自报，不能视为独立验收：DB mode=ro、daemon PID 全程未重启、119 次工具调用、SAM 81/81、153 分钟、五条验收 PASS、无残留进程。

更关键的是：run2 使用的是 ba20c68，输入已预先转成 PNG，image-edit provider 未配置。它证明的是 photographic 检测、未配置时软回退、归属披露和原图导出；没有证明：

- HEAD 159d72c 的真实 JPEG 直传归一；
- 真实 image-edit 参考图层生成；
- IoU 门通过/拒绝；
- 分件实际使用生成的参考图层；
- 工作台 UI 三态真实浏览器链路。

原始 JPEG 死链转录反而是有效的缺陷证据，但它发生在修复前。

## 四、需修/补证（终审开出）

1. 用 HEAD 跑真实 JPEG 直传 live 回归，并确认最终 session/task/export 全链只引用归一 ref。
2. 配置真实 image-edit provider，跑生成成功、生成失败、IoU 不过三类旗舰证据。
3. 补齐 T7.2 四态集成测试与 T7.3 Owner 交付闭合。
4. 删除或明确 UI canvas 转换器与服务端归一器的职责，若保留则补跨入口等价契约。

## 五、Owner 裁决位（终审开出）

1. pavingStyle 默认 full、accent，还是强制显式选择。
2. 归属门 v1 是否继续披露不阻断。
3. 是否接受 routing 的 daemon 文案后批。
4. 是否接受在真实 image-edit 与 HEAD JPEG 旗舰重跑前归档发布。

## 六、战役最终结论

> 整个 SAM 升级战役的最终结论：坐标、引用、导出和 Studio 路由的工程骨架已经打通，T7a 证明了预转换 PNG 加软回退路径可观测可导出；但真实参考图层生成、HEAD JPEG 归一旗舰证据、铺法默认值和归属策略尚未闭合，因此最终只能判定为研发/灰度条件 GO，正式发布与完整归档 NO-GO。

（Worked for 28m 28s）

---

## 增量批处置（2026-10-05，本文件追加——增量复审材料）

- 需修① 已闭合：HEAD 159d72c live 回归 12/12 PASS（`experiments/sam-playbook-20261004/t7a-flagship/jpeg-live-regression/`——run1 同字节重放、归一 ref 全链单源、帧流零 JPEG ref、S2 photographic、~2min done）。
- 需修③ 已闭合：tasks.md 真值勾选（顶层 1.1/1.3/1.4/1.5 落地引用；6.2 补 vision 走查 8/8；7.2 四态测试复核勾选——reference-image.test.ts:615/:396-434/:453+flat-aux-t6.test.ts:212-227；7.1 标注已证/仍开放边界；7.3 终审+部署已完成注记）。
- 需修④ 已闭合（零行为变更）：转换器职责显式化——attachments.ts[4]/rpc.ts 注释声明「服务端 followup 归一=权威单源；客户端=预转换优化；收敛契约=会话附件入线恒 PNG（非逐字节同 PNG）」；聚焦测试 23+套件绿、svelte-check 0 错。
- 需修② 仍开放：待 Owner 配置 image-edit 路由（裁决位④关联）。
- 工作台 UI 三态真实浏览器链路（终审第三节「没有证明」清单第 5 项）：vision 双走查 2026-10-05 B1/B2 已补（未生成态实况+挂锁+结构不可选；重新生成→typed 拒实录+autoApprove 不被绕过；分享包五产物+混合预览）——8/8 PASS。

---

# 增量复审结论（2026-10-05 02:22 · 同会话续审 · 全文照录）

> 增量复审结论：① JPEG live、③任务真值、④转换器职责均闭合；②真实 image-edit 旗舰路径仍开放。
>
> | 对象 | 新评分 | 放行判定 |
> |---|---|---|
> | add-flat-aux-segmentation | 8.7/10 | 研发/灰度条件 GO；正式归档仍 NO-GO |
> | unify-studio-routing | 8.8/10 | Studio 路由 GO；完整 change 仍保留 daemon 后批尾项 |
> | 旗舰证据链 | 7.8/10 | JPEG/UI/回退证据可接受；完整参考图层旗舰仍 NO-GO |
>
> **① JPEG live 回归：闭合。** 核对了 jpeg-live-regression/report.md 和 verify-result.json，12 项均为 ok=true：上传 JPEG 627d3260… 与 scene.analyze 使用的 PNG 4d9eddcf… 不同；归一 blob 有 PNG 魔数、尺寸 1280×1280；tasks.params 和会话帧流均无 JPEG ref；intake-image.png、scene-analysis.json 在场，style=photographic；任务终态 done，无 image-decode-failed。
> 「导出链闭合」的论证作为工程契约证据可以接受：followup 将归一 ref 写入任务附件审计，sessionImageSet() 从同一 tasks.params.attachments 读取，sourceImageOfSession() 再由该主图集 ref 构造导出源；T5.1 测试确认 source.img 与该附件字节相等（daemon/src/kernel/index.ts:716、daemon/src/capability/task-images.ts:92、daemon/src/capability/task-export.ts:791）。边界必须保留：本次轻指令没有实际生成新的导出 bundle，因此这是「代码契约 + live 入线证据」的闭合，不是本次 run 的 live export receipt。
>
> **③ 任务真值：闭合，但 7.1/7.3 仍应保持开放。** tasks.md 顶层 1.1/1.3/1.4/1.5、6.2、7.2 已勾选并有落地引用；源码也能对应到 max-token、RUNAWAY_LIMIT=5、IoU 门和四态测试。1.5 的实现面已闭合为显式 full/accent 选项，但默认值仍是 Owner 裁决。7.1 保持未勾是正确的：真实 image-edit 成功、IoU 通过、分件实际采用参考图层仍未 live 证明。7.3 也仍未勾，Owner 交付报告尚未完成最终签收。
>
> **④ 转换器职责：闭合。** f2a7bde 对 attachments.ts:15 和 rpc.ts:469 只有职责注释增量，没有行为变化。契约表述准确：服务端 followup 归一是权威正确性入口；客户端转换是带宽/旧 daemon 优化；跨入口保证「会话附件入线恒为 PNG」，不保证两套编码器逐字节相同。消除了此前「单源」措辞歧义。
>
> **工作台 UI 证据已补强。** 查看了 /tmp/final-walk/ 的 B1/B2/B3 截图：未生成态、锁定与不可选结构可见；重新生成显示 image-edit 未配置的 typed 拒绝；分享页混合预览滑杆可见。足以移除「完全没有 UI 证据」的缺口，但仍属于已提供的走查 receipt，未重新启动浏览器或 8317。
>
> **仍需 Owner 决定：** ① 配置 image-edit 路由后，补真实生成成功、生成失败、IoU 不过、分件采用参考图层的旗舰 run；② pavingStyle 缺省是否固定为 full、accent 或强制显式选择；③ attribution v1 是否继续「披露不阻断」；④ 是否接受 unify-studio-routing 的 daemon 分享页文案留后批。
>
> **一句话结论：本轮已把 JPEG 入线、任务闭合、转换器职责和 UI 三态证据补齐，战役可继续按研发/灰度条件 GO；但真实 image-edit 参考图层生成仍未实跑，因此正式发布与完整归档判定维持 NO-GO。**
>
> （Worked for 7m 5s · 复审后 Codex 会话已回收：Ctrl+C 退出 + workspace w8H close）
