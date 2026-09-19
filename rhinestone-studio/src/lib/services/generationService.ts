/**
 * 实验室生图 service：**仅接口位**（rename-and-expert-workbench S-4.3；design §4.4）。
 *
 * 归属声明：生图生命周期契约（发起/进度/取消/结果档案的形状）由姊妹 change
 * **add-lab-drill-params-and-blueprint** 定义与冻结——本文件只占接口位，
 * **禁止预填字段**（避免与姊妹 change 的契约 gate 抢真源；design §4.4 原文义务）。
 * 姊妹 change 冻结契约后在此落字段与实现；在此之前本模块零运行时导出。
 */

/**
 * 生图 service 接口占位（骨架）。
 * 生命周期形状留空待冻结——不预填发起/进度/取消/结果档案的任何字段
 * （空接口是本切片的交付形态，非遗漏）。
 */
export interface GenerationService {}
