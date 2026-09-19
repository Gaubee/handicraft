/*
 * Orthogonal intents (max 1):
 * 1. [2026-09-19 Contract / add-project-files 0.1] 引擎语义身份唯一真源：ENGINE_VERSION 写入 .gemproj
 *    （重放漂移横幅的比对基准——保存时记录值 ≠ 当前值 → 黄色横幅 + 覆写存活清点，design §1.1）。
 *    本文件是引擎层唯一新增面（tasks 0.1 边界冻结：不改任何算法语义，不并入 index.ts 公共出口）。
 *
 * [bump 纪律]（design §1.1 / tasks.md 0.1，横幅诚实性前提）：
 * - segment / 布局 / 颜色映射的**语义**变更（同参数产出不同 blocks/gems/colorId）必 bump +1；
 *   推导常量的语义性改写（SEGMENT_GEM_DIAMETER_PX 取值、minAreaFor 算式等影响输出的变更）同 bump
 *   （这些常量按 design §1.1 不冻结进文件，归 engineVersion 语义管辖）。
 * - 纯重构 / 性能优化 / 内部 bug 修复但输出不变 → 不 bump。
 * - bump 时同步：projectFile 序列化自动携带新值（serializeGemproj/Gemdoc 直读本常量）；
 *   若文件字段随之变更则同时注册迁移链并附 round-trip 字节等价测试（projectFile §1.3 纪律）。
 * - 引擎其余文件不得另立同义常量；消费方一律 `import { ENGINE_VERSION } from '$lib/engine/version'`。
 */
/**
 * v2（gem-catalog engine gate 1.6，design §2.5）：validate/validateEditable/resolveGreedy 判据
 * 从单一 pitch×0.999 → 逐对圆包络 requiredCenterDistancePx×0.999（等径圆钻与 v1 逐位等价——
 * 单规格圆钻文档 v1/v2 钻位逐位不变护栏见 engineGolden/versionGuard 测试）；exportGate 新增
 * missing-asset 硬阻断面；BOM 聚合键 colorId → specKey×colorId；SVG 逐钻规格渲染。
 * 布局算法本体零变化（layout 输出与 v1 黄金逐位相等）；CVT 优化（1.5）输出逐位不变不参与 bump。
 */
export const ENGINE_VERSION = 2;
