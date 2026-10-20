// 密码库对导入管线的接口：类型以导入管线那份为准（读取器读出来的一条在 protected-types.mts，计数和写入口在 sinks.mts）
export type { ImportedPassword } from '../../browser-import/protected-types.mjs'
export type { ImportCounts, PasswordSink } from '../../browser-import/sinks.mjs'
