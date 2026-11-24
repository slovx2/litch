// 交给 OpenCode serve 的插件（经 OPENCODE_CONFIG_CONTENT 的 plugin 挂上，见 threadPluginConfig）：
// OpenCode 一个 serve 跑所有会话，模型的 bash 工具和用户的 ! 命令都继承 serve 的环境，没有会话号。
// 它的 shell.env 钩子带着发起命令的 sessionID，这里写成 LITCH_THREAD_ID，设备据此认出命令属于哪个 Litch 会话
// （经理注入的 gh/Git 身份、litch-machine 的确认卡片）。子代理（task 工具）跑在子会话里，子会话不是 Litch 打开的线程：
// 顺着 parentID 找到最上面的会话，和 Claude 的子代理一样算在发起它的会话名下。查不到上级时用自己的会话号。
// 这个文件被 OpenCode 自己的运行时直接装载，不能引用别的模块。

interface SessionClient {
  session: {
    get(options: {
      path: { id: string }
      query?: { directory?: string }
    }): Promise<{ data?: { parentID?: unknown } | null } | undefined>
  }
}

const MAX_DEPTH = 8

export async function rootSession(
  client: SessionClient | undefined,
  sessionID: string,
  directory: string | undefined,
  parents: Map<string, string | null>,
): Promise<string> {
  let id = sessionID
  for (let depth = 0; client && depth < MAX_DEPTH; depth += 1) {
    if (!parents.has(id)) {
      const parent = await client.session
        .get({ path: { id }, ...(directory ? { query: { directory } } : {}) })
        .then((result) => {
          const parent = result?.data?.parentID
          return result?.data ? (typeof parent === 'string' && parent ? parent : null) : undefined
        })
        .catch(() => undefined)
      // 查不到不记：下一条命令再问一次
      if (parent === undefined) return id
      parents.set(id, parent)
    }
    const next = parents.get(id)
    if (!next) return id
    id = next
  }
  return id
}

export default {
  id: 'litch-thread',
  server: async (input: { client?: SessionClient; directory?: string }) => {
    // 子会话 → 上级会话（没有上级的是 null）；上下级关系建了就不变
    const parents = new Map<string, string | null>()
    return {
      'shell.env': async (
        hook: { cwd?: string; sessionID?: string },
        output: { env: Record<string, string> },
      ) => {
        if (!hook.sessionID) return
        output.env.LITCH_THREAD_ID = await rootSession(
          input.client,
          hook.sessionID,
          input.directory,
          parents,
        )
      },
    }
  },
}
