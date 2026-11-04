// 标准 app-server 无对应字段的 ACP 控制。只能由声明 acpControls 的客户端显式调用。

import type { AcpAuthView } from '../../protocol/src/acp-controls.mjs'
import { ProtocolError, requiredString } from '../../shared/src/protocol-contract.mjs'
import { choices } from './catalog.mjs'
import { AcpError } from './connection.mjs'
import { settings } from './envelope.mjs'
import type { AcpServer } from './server.mjs'

export async function control(s: AcpServer, method: string, params: any): Promise<unknown> {
  const agent = await s.runtime.agent()
  if (method === 'litch/acp/auth/read') {
    let status: AcpAuthView['status'] = 'unknown'
    // agy 没有 auth/status；只读 list 在未登录时返回标准 Authentication required。
    // 不创建会话、不取令牌；网络或其他故障不能冒充未登录。
    if (s.agentId === 'agy' && agent.caps.list) {
      try {
        await agent.connection.request('session/list', {}, 10000)
        status = 'signedIn'
      } catch (error) {
        if (error instanceof AcpError && error.code === -32000) status = 'signedOut'
        else throw error
      }
    }
    return {
      status,
      methods: agent.caps.authMethods,
      logout: agent.caps.logout,
      instruction: s.agentId === 'agy' ? 'agy acp --login' : null,
    }
  }
  if (method === 'litch/acp/auth/authenticate') {
    const id = requiredString(params.methodId, 'methodId')
    const choice = agent.caps.authMethods.find((entry) => entry.id === id)
    if (choice?.type !== 'agent')
      throw new ProtocolError(
        -32602,
        '只能 authenticate agent 已声明的 agent 类型鉴权方式；terminal 类型需用户在终端完成',
      )
    // 不传 key、token 或任意用户附加字段；登录交给 agent 自己完成。
    await s.ask(agent, 'authenticate', { methodId: id })
    return {}
  }
  if (method === 'litch/acp/auth/logout') {
    if (!agent.caps.logout) throw new ProtocolError(-32601, 'agent 没有声明 logout')
    await s.ask(agent, 'logout', {})
    return {}
  }
  if (!['litch/acp/config/read', 'litch/acp/config/set'].includes(method))
    throw new ProtocolError(-32601, `未知 ACP 控制方法 ${method}`)
  const live = await s.load(requiredString(params.threadId, 'threadId'))
  if (method.endsWith('/read')) return { configOptions: live.projection.configOptions ?? [] }
  if (live.running) throw new ProtocolError(-32004, 'ACP 配置在回合结束后才能修改')
  await s.attach(live)
  const configId = requiredString(params.configId, 'configId')
  const option = live.projection.configOptions?.find((entry) => entry.id === configId)
  if (!option || (option.type !== 'select' && option.type !== 'boolean'))
    throw new ProtocolError(-32602, 'agent 没有声明这个可编辑配置项')
  if (
    option.type === 'boolean'
      ? typeof params.value !== 'boolean'
      : !choices(option).some((entry) => entry.value === params.value)
  )
    throw new ProtocolError(-32602, '配置值不在 agent 声明范围内')
  const result = await s.ask(agent, 'session/set_config_option', {
    sessionId: params.threadId,
    configId,
    value: params.value,
    ...(option.type === 'boolean' ? { type: 'boolean' } : {}),
  })
  if (!Array.isArray(result?.configOptions))
    throw new ProtocolError(-32603, 'agent 未返回完整 configOptions')
  live.projection.configOptions = result.configOptions
  s.persistCatalog(live)
  s.notify(params.threadId, 'thread/settings/updated', { threadSettings: settings(s, live) })
  return { configOptions: result.configOptions }
}
