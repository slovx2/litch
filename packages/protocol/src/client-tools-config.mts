// 配置 Litch（命名空间 litch_config）：本机 harness 里的模型照“Litch 产品手册”技能跑 `litch config …`
// （手册目录里的 scripts/litch，壳里是应用自带适配器的 `config` 子命令），命令行把参数原样经 device.sock 的
// `litch/clientTool/invoke` 交给连着的 Litch 桌面端，由桌面端核心里的执行器解析、执行、回一段字。
//
// 只走 invoke，不进会话的 dynamicTools（不给每个会话多塞一套工具定义）。参数怎么解析、有哪些操作、帮助怎么写，
// 都只在执行器一处（packages/core），命令行不认操作名，所以加操作不用改 Go。
//
// 这个文件不引用别的文件。

/**
 * 命名空间。不放进 client-tools.mts 的 CLIENT_TOOL_NAMESPACE：那一组每个都有给模型的工具定义、会进 dynamicTools，
 * 这个没有。桌面端照样在握手的 litchClientTools.namespaces 里声明它，设备进程才知道 invoke 交给谁
 */
export const CONFIG_NAMESPACE = 'litch_config'

/** 执行器唯一的工具名 */
export const CONFIG_TOOL = 'run'

/** `litch/clientTool/invoke` 里 namespace 为 litch_config、tool 为 run 时的 arguments */
export interface ConfigRunArguments {
  /** `litch config` 之后的参数，原样 */
  argv: string[]
  /** 带了 --json：结果给结构化的 JSON（放在唯一一段文字里） */
  json: boolean
  /** 命令行按环境（LANG、LC_ALL）猜的语言；猜不出是 null，执行器用界面的语言 */
  lang: 'zh-CN' | 'en' | null
}
