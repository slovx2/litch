// 测试用的执行器：litch_echo 命名空间的 echo 工具，原样回文字，可选回一张小图、可选先问用户一句。
// 用来打通“建会话带工具 → 模型调用 → 引擎发 item/tool/call → 核心 → 主进程 → 执行器 → 结果回到模型”这一整条链路，
// 平时不登记：只有 LITCH_CLIENT_TOOLS_ECHO=1 时才有（registry.mts）。
import {
  CLIENT_TOOL_NAMESPACE,
  clientToolFailure,
} from '../../../../packages/protocol/src/client-tools.mjs'
import type { EchoArguments } from '../../../../packages/protocol/src/client-tools-specs.mjs'
import type { ClientToolExecutor } from './types.mjs'

/** 结果里带的那张小图：8×8 的一块橙色 PNG */
export const ECHO_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4kOCAFTEMLQkAqvNgAe4thfAAAAAASUVORK5CYII='

/** 问用户时用的网站：保留的顶级域名，不会真的有人去访问 */
export const ECHO_SITE = {
  origin: 'https://echo.litch.invalid',
  url: 'https://echo.litch.invalid/echo',
}

export const echoExecutor: ClientToolExecutor = {
  namespace: CLIENT_TOOL_NAMESPACE.echo,
  async call(invocation, context) {
    if (invocation.tool !== 'echo') {
      return clientToolFailure(
        'invalid',
        `Unknown tool ${invocation.tool}. The only tool here is echo.`,
      )
    }
    const args = (invocation.arguments ?? {}) as Partial<EchoArguments>
    if (typeof args.text !== 'string') {
      return clientToolFailure('invalid', 'The echo tool needs a "text" string.')
    }
    if (args.ask === true) {
      const answer = await context.ask({ kind: 'site', ...ECHO_SITE })
      if (answer === 'decline') return clientToolFailure('declined', 'The user declined the echo.')
      if (answer === null) return clientToolFailure('failed', 'The echo was cancelled.')
    }
    if (context.signal.aborted) return clientToolFailure('failed', 'The echo was cancelled.')
    return {
      success: true,
      contentItems: [
        { type: 'inputText', text: args.text },
        ...(args.image === true ? [{ type: 'inputImage' as const, imageUrl: ECHO_IMAGE }] : []),
      ],
    }
  },
}
