import { ProtocolError, pageRecords } from '../../shared/src/protocol-contract.mjs'
import {
  CODEX_PROTOCOL_VERSION,
  codexUserAgent,
  platformFamily,
  platformOs,
} from '../../shared/src/runtime-version.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { runtimeInfo } from './declaration.mjs'
import type { AntigravityServer } from './server.mjs'
import { envelope, settings } from './store.mjs'

export async function dispatch(
  s: AntigravityServer,
  peer: RpcPeer,
  method: string,
  p: any,
): Promise<any> {
  switch (method) {
    case 'initialize':
      s.initialize(peer, p)
      return {
        userAgent: codexUserAgent(
          p.clientInfo?.name ?? 'codex-app',
          p.clientInfo?.version ?? 'unknown',
          CODEX_PROTOCOL_VERSION,
          'codex-harness-adapter-antigravity',
        ),
        codexHome: s.home,
        platformFamily: platformFamily(),
        platformOs: platformOs(),
      }
    case 'runtime/info':
      return runtimeInfo()
    case 'account/read':
      return { account: null, requiresOpenaiAuth: false }
    case 'configRequirements/read':
      return { requirements: null }
    case 'modelProvider/capabilities/read':
      return { imageGeneration: false, webSearch: false }
    case 'config/read':
      return {
        config: {
          model: s.config.values().model,
          model_provider: 'agy',
          approval_policy: 'on-request',
          sandbox_mode: 'danger-full-access',
        },
        origins: {},
        layers: null,
      }
    case 'permissionProfile/list':
      return { data: [], nextCursor: null }
    case 'collaborationMode/list':
      return { data: [] }
    case 'model/list': {
      const model = s.config.values().model
      return {
        data: [
          {
            id: model,
            model,
            displayName: model,
            description: model,
            hidden: false,
            modelSpecialty: null,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'none',
            inputModalities: ['text'],
            supportsPersonality: false,
            upgrade: null,
            availabilityNux: null,
            upgradeInfo: null,
          },
        ],
        nextCursor: null,
      }
    }
    case 'skills/list':
      return {
        data: (p.cwds ?? [process.cwd()]).map((cwd: string) => ({ cwd, skills: [], errors: [] })),
      }
    case 'thread/start':
      return settings(await s.create(peer, p))
    case 'thread/resume': {
      const thread = s.store.get(p.threadId)
      s.checkSelection(p, thread)
      await s.open(thread)
      s.subscribe(peer, thread.id)
      return settings(thread)
    }
    case 'thread/read':
      return { thread: envelope(s.store.get(p.threadId), p.includeTurns === true) }
    case 'thread/list': {
      const rows = [...s.store.threads.values()].sort((a, b) => a.updatedAt - b.updatedAt)
      const page = pageRecords(
        rows,
        p,
        'agy:threads',
        (thread) => thread.id,
        (thread) => !p.archived && (!p.cwd || p.cwd === thread.cwd),
      )
      return { ...page, data: page.data.map((thread) => envelope(thread, false)) }
    }
    case 'thread/loaded/list':
      return { data: [...s.live.keys()], nextCursor: null }
    case 'thread/turns/list':
      return pageRecords(s.store.get(p.threadId).turns, p, `agy:${p.threadId}`, (turn) => turn.id)
    case 'turn/start':
      return { turn: await s.start(peer, p) }
    case 'turn/interrupt':
      await s.interrupt(p.threadId, p.turnId)
      return {}
    case 'litch/harness/config/read':
      return s.config.read()
    case 'litch/harness/config/write': {
      const result = s.config.write(p)
      setImmediate(() => s.changed())
      return result
    }
    case 'litch/harness/providers/read':
      return s.config.providers()
    case 'litch/harness/auth/start':
      throw new ProtocolError(
        -32004,
        '请通过账号设置的 GEMINI_API_KEY 项配置；SDK 尚无订阅登录接口',
      )
    case 'server/diagnostics':
      return {
        process: {
          id: process.pid,
          residentMemoryBytes: process.memoryUsage.rss(),
          physicalFootprintBytes: null,
        },
        gauges: [{ name: 'agy_adapter.loaded_sessions', value: s.live.size }],
      }
    default:
      throw new ProtocolError(-32601, `Antigravity SDK 入口尚不支持 ${method}`)
  }
}
