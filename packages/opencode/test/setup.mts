import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { keepSystemEnv } from '../../shared/test/system-env.mjs'

// 由测试命令用 --import 预加载，夹具 client.mts 也导入（直接跑单个用例同样隔离）。
// 被测入口原样把 process.env 交给真实 opencode serve：只留系统变量和下面点名的测试开关，
// 宿主的模型凭据、代理、OPENCODE_* 设置都不进来；模型只有 isolate() 写进配置的回环假模型。

// 官方安装脚本装在用户 HOME 下：换 HOME 之前先记下，免得本机只这样装过时整组跳过。
if (!process.env.CHA_OPENCODE_CLI?.trim()) {
  const installed = join(homedir(), '.opencode/bin/opencode')
  try {
    accessSync(installed, constants.X_OK)
    process.env.CHA_OPENCODE_CLI = installed
  } catch {}
}
keepSystemEnv([
  // 指定被测的 opencode（CI 装在隔离目录里）
  'CHA_OPENCODE_CLI',
  // 维护与排障开关：只写进调用方自己指的位置
  'CHA_OPENCODE_TRACE',
  'CODEX_SCHEMA_DIR',
  'LITCH_COMPAT_DUMP',
])
