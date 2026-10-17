import type { OpencodeServer } from './server.mjs'

// OpenCode 的模型目录和 MCP 服务名。模型目录问 GET /provider（all、default、connected）和 GET /config 的 model，
// 只列已连上的提供方（connected）的模型；模型的标识是“提供方/模型”，和 OpenCode 自己的写法一样。
// 强度对的是 OpenCode 的 variant（各模型自己带的几档，比如 low、high）；default 是“不指定 variant”，
// 用模型自己的默认设置，每个模型都有这一档。

const TTL_MS = 30_000
export const DEFAULT_EFFORT = 'default'

interface Snapshot {
  at: number
  providers: any
  config: any
}

/** “提供方/模型”拆成两段；模型名里可以有斜杠，提供方名里没有 */
export function splitModel(
  id: string | null | undefined,
): { providerID: string; modelID: string } | null {
  const slash = id?.indexOf('/') ?? -1
  if (!id || slash < 1 || slash === id.length - 1) return null
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
}

export class Catalog {
  private readonly server: OpencodeServer
  private snapshot: Snapshot | null = null
  private loading: Promise<Snapshot> | null = null
  private mcp: string[] = []

  constructor(server: OpencodeServer) {
    this.server = server
  }

  private async load(): Promise<Snapshot> {
    if (this.snapshot && Date.now() - this.snapshot.at < TTL_MS) return this.snapshot
    this.loading ??= (async () => {
      const api = await this.server.api()
      const [providers, config] = await Promise.all([
        api.request('GET', '/provider'),
        api.request('GET', '/config').catch(() => ({})),
      ])
      this.snapshot = { at: Date.now(), providers, config }
      return this.snapshot
    })().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  /** 已连上的提供方的模型（OpenCode 的原样），按提供方、模型 */
  private connected(snapshot: Snapshot): Array<{ provider: any; model: any }> {
    const connected = new Set<string>(snapshot.providers?.connected ?? [])
    return (snapshot.providers?.all ?? [])
      .filter((provider: any) => connected.has(provider.id))
      .flatMap((provider: any) =>
        Object.values(provider.models ?? {})
          .filter((model: any) => model?.status !== 'deprecated')
          .map((model: any) => ({ provider, model })),
      )
  }

  /** OpenCode 新会话会用的模型：配置里写的 model，没写的是头一个已连上的提供方的默认模型 */
  private preferred(snapshot: Snapshot): string | null {
    const listed = new Set(
      this.connected(snapshot).map(({ provider, model }) => `${provider.id}/${model.id}`),
    )
    const configured = snapshot.config?.model
    if (typeof configured === 'string' && listed.has(configured)) return configured
    for (const id of snapshot.providers?.connected ?? []) {
      const model = snapshot.providers?.default?.[id]
      if (model && listed.has(`${id}/${model}`)) return `${id}/${model}`
    }
    return listed.values().next().value ?? null
  }

  /** model/list 的 data */
  async models(): Promise<any[]> {
    const snapshot = await this.load()
    const preferred = this.preferred(snapshot)
    return this.connected(snapshot).map(({ provider, model }) => {
      const id = `${provider.id}/${model.id}`
      const variants = Object.keys(model.variants ?? {}).filter((name) => name !== DEFAULT_EFFORT)
      return {
        id,
        model: id,
        displayName: String(model.name ?? model.id),
        description: String(provider.name ?? provider.id),
        hidden: false,
        modelSpecialty: null,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: id === preferred,
        supportedReasoningEfforts: [
          { reasoningEffort: DEFAULT_EFFORT, description: '模型自己的默认设置' },
          ...variants.map((name) => ({ reasoningEffort: name, description: name })),
        ],
        defaultReasoningEffort: DEFAULT_EFFORT,
        inputModalities: model.capabilities?.input?.image === false ? ['text'] : ['text', 'image'],
        supportsPersonality: false,
        upgrade: null,
        availabilityNux: null,
        upgradeInfo: null,
      }
    })
  }

  /** OpenCode 给新会话的默认模型；问不到时是 null */
  async defaultModel(): Promise<string | null> {
    return this.preferred(await this.load().catch(() => ({ at: 0, providers: {}, config: {} })))
  }

  /** 模型在不在目录里（不在的话发消息会失败） */
  async has(id: string): Promise<boolean> {
    const snapshot = await this.load()
    return this.connected(snapshot).some(
      ({ provider, model }) => `${provider.id}/${model.id}` === id,
    )
  }

  /** 模型的上下文窗口；目录还没取过或者没有这个模型时是 null（不为这个去问 OpenCode） */
  contextWindow(providerID: string, modelID: string): number | null {
    const provider = (this.snapshot?.providers?.all ?? []).find(
      (entry: any) => entry.id === providerID,
    )
    const limit = provider?.models?.[modelID]?.limit?.context
    return typeof limit === 'number' && limit > 0 ? limit : null
  }

  mcpServers(): readonly string[] {
    return this.mcp
  }

  /** 问一下这个目录配了哪些 MCP 服务（GET /mcp 的键），拆 MCP 工具名用；问不到不要紧 */
  async refreshMcp(directory: string): Promise<void> {
    const api = this.server.runtime.current()
    if (!api) return
    const status = await api
      .request('GET', '/mcp', { directory, timeoutMs: 5000 })
      .catch(() => null)
    if (status && typeof status === 'object')
      this.mcp = [...new Set([...this.mcp, ...Object.keys(status)])]
  }
}
