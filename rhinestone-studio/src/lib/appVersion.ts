/**
 * 应用版本标识（唯一真源，[add-project-files 4.3] 收口）。
 *
 * 写入 .gemtpl / .gemgen 文件的 `appVersion` 字段（labFile 序列化层要求非空 string），
 * 以及模板迁移引擎（templateMigration deps.appVersion）的接线值。
 * 仓内任何模块不得再各自声明局部版本常量——发版时只改这一处（与 package.json version 对齐）。
 */
export const APP_VERSION = '0.1.0'
