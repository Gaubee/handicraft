# Tasks: add-flat-aux-segmentation

## 0. 前置实弹·工作画布确定性（Owner 报障 2026-10-04「辅助图 512×512mm 未铺满画布」根因修复）

> 归属说明：本修复是 proposal §1「四图引用分离/坐标一致性」门的第一实弹——iter-5 会话
> 76b63ed7 实证的分析锚（500px/ppm 2.5）与树锚（1280px/ppm 6.4）分叉，正是该门要防的
> 坐标系漂移。proposal §1 验收里的「1280 树+500 分析图定向回归」已在 daemon 侧落地
> （segment-tool.test.ts [3b] Bug A 回归），change 主体（风格检测/辅助图生成/几何一致性门）
> 仍在立项推进。

- [x] 0.1 Bug A（daemon）：`planIntakeResample` 改规范网格恒等推导（canvasCm 在场时
      imagePx 恒=round(canvasCm×ppcmTarget)，与上传格式/尺寸无关；升采同采——旧「只降
      不升」废止；纵横比漂移>2% 透传保留 S1 显式拒迟到面）；`resampleRgbaArea` 升采同式
      （box 上采样）；新增 `applyIntakeResample` 入线编排单源（intake-image.png 工件+帧）
- [x] 0.2 Bug A（接线）：subject.segment 入线接入推导（elements 直注跳过 scene.analyze
      的路径同样推导——iter-5 分叉根因）+kernel 装配 intakeConfigProvider（与
      scene.analyze 同源）；确定性推导使两入线口各自调用亦得同一 blobRef（锚点互洽）
- [x] 0.3 Bug B（契约/投影）：TaskDetailTreeSchema 增 canvasCm/imagePx（树=工作画布
      真源锚）+task.detail 投影
- [x] 0.4 Bug B（UI）：工作台取锚序 tree→gems→baseImage（旧序 baseImage 优先把
      500px 分析声明配 1280px bbox——1280÷2.5=「512×512 mm」幻数+辅助图不铺满双症状）；
      废弃 `{w: imagePx/2}` 伪造 canvasCm 兜底（无锚=PIXELS_PER_MM 显式降级 exact=false）
- [x] 0.5 回归：intake-resample 双路同锚（3000/1280/736/400→同一 500）+设置跟随
      （40px/cm→800）+aspect 漂移透传；scene.analyze 升采/幂等；segment-tool iter-5
      定向（原始 1280 blob+elements→树 500×500+同锚二调零变迁）；studio 树锚 6.4 ppm
      回归（1280 树+500 baseImage 分叉→mm=px÷6.4=200 满幅）
- [x] 0.6 兼容性：旧任务（500px 与 1280px 双型）树/布局工件已落盘自洽——task-layout
      ppm=imagePx/(canvasCm×10) 单源不变，旧档零迁移零重算；修复只影响**新任务**的入线
      推导（透传幂等：已在规范网格上的锚点零变迁）

## 1. 风格检测与辅助图链路（change 主体——立项中）

- [ ] 1.1 design：风格检测判据（低梯度/平坦色域占比 vs VLM 判定）+辅助图生成通道选型
- [ ] 1.2 四图引用分离：原图/辅助图/scene-analysis 降采样图/树掩膜源图显式引用+坐标
      变换关系；修 P1 树编辑锚点（tree.ts:108）；1280 树+500 分析图定向回归（daemon 侧
      已由 0.2 覆盖入线推导面，本项覆盖树编辑面）
- [ ] 1.3 辅助图几何一致性门：掩膜一一映射回原图校验；不一致回退原图流程或显式变换
- [ ] 1.4 scene-analysis 稳健性：输出规模与重试预算有界（iter-5 三连败教训）
- [ ] 1.5 策略冻结：密度/点缀风格显式选项或默认规则；部件级钻数从最终 layout 复核
