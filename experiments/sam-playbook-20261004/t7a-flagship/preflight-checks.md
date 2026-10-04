# T7a 前置三验证据（run2，任务 34260f3e-603f-43f9-809d-910a42c53d65）

验证时间：2026-10-04T14:39-14:44Z（DB mode=ro，帧流+工件 blob 只读取证）

## ① scene-analysis 工件 style 字段 = photographic ✓

- 工件帧 #17：`scene-analysis.json` blobRef `d2a8a7ea0a37301f…`
- 工件内容（节选）：`"style": "photographic"`，imagePx 500×500，canvasCm 20×20，imageBlobRef=e8a00855（=intake-image.png 归一锚），elements 30 个（六颗亮星已逐颗列出：左上/上中/中上/右上/左侧+大亮星）
- 判定链：T1 风格检测（scene-analyze schema 增 style）→ photographic → 触发参考图层生成编排 ✓

## ② reference-image 软回退证据 ✓

- 帧流 #18（log 帧，紧随 #17 scene-analysis 落档之后、S3 语义抠图 progress 之前）：
  ```
  [参考图层] reference-image-unconfigured：image-edit 路由未配置（后台模型设置需一条 api=openai-image-edit 且带密钥的路由）——参考图层生成跳过，分件回退原图
  ```
- 工件面：任务工件帧全列（#1 stones-manifest.json / #10+#16 intake-image.png / #17 scene-analysis.json）——**无 reference-image.png 帧、无 reference-image-report.json 帧**（未配置态在源图读取前返回，连 report 都不落）
- DB settings.models_routes 只有一条 zai-api/anthropic-messages 对话路由——image-edit provider 未配置态成立
- 回退语义生效：S3 语义抠图输入继续使用原图链（intake 500×500 锚），任务未被阻塞

## ③ 工作画布 500×500 ✓

- 工件帧 #10（scene_analyze 首调内）+ #16（重试调内幂等同锚）：`intake-image.png` blobRef `e8a008551459879aa556a97b067babe5312e029f63ca487d41755431c34bb2b7`
- blob 实测：PNG 签名合法，738260 B，**500×500**（上传原 1280×1280 → 20cm 规范网格 round(20×25px/cm)）
- scene-analysis 声明 imagePx 500×500 与 blob 一致——S0 归一面（Bug A 修复 0.1）在新任务入线生效

## 附：run1（JPEG 死链）记录——豁免重跑依据

- run1 任务 65766bd3-b1e8-46be-9511-0b079254c1fe（上传原版 JPEG 字节 274101B，sha256 627d3260…）
- agent 三面探测全被 S0 PNG-only 门拒：#9-11 scene_analyze `image-decode-failed`（decodePng 在 applyIntakeResample 之前——scene-analyze.ts:427-433）/ #27-29 subject_segment elements 直注同拒 / #32-34 pave-preview 同拒
- agent 无文件转换工具，6.3 分钟诚实终报终态 done，零分件产出（转录存档 jpeg-deadlink-run/）
- 定性：上传面接受任意格式 ↔ 视觉管线 S0 PNG-only 的管线级不兼容——实验目的（style 检测触发）无法达成，构成基础设施故障，按铁律重跑 1 次（已用）
- 产品缺陷记录（移交 Owner）：JPEG/JPEG 类附件应在上传面转码归一或显式拒绝并提示，而非进入会话后死链
- run2 恢复历轮口径：sips 源 JPG→PNG（sha256 6267829d311a27ee098b248f61bcb8afe31db0cfdcf76039a4453d4184aba5b9，2984658B，与 iter-1/2/3/4 blobRef 逐字节一致）
