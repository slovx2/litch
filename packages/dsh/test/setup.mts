import { join } from 'node:path'
import { keepSystemEnv } from '../../shared/test/system-env.mjs'

// 由测试命令用 --import 预加载，夹具 client.mts 也导入（直接跑单个用例同样隔离）。
// 被测入口原样把 process.env 交给真实 dsh：只留系统变量和下面点名的测试开关，宿主的模型凭据、代理、
// CHA_DSH_HOME/DSH_HOME 都不进来；凭据只有这里和 isolate() 给的假值，模型地址是连不上的回环端口。
const home = keepSystemEnv([
  // 指定被测的 dsh（CI 装在隔离目录里）
  'CHA_DSH_CLI',
  // 维护与排障开关：只写进调用方自己指的位置
  'CHA_DSH_TRACE',
  'CHA_DSH_SESSION_LOG',
  'CODEX_SCHEMA_DIR',
  'LITCH_COMPAT_DUMP',
])
Object.assign(process.env, {
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/anthropic',
  DEEPSEEK_API_KEY: 'mock-not-a-real-key',
  DSH_HOME: join(home, '.dsh'),
  DSH_AGENTS_HOME: join(home, '.agents'),
  DSH_TELEMETRY_DISABLED: '1',
})
