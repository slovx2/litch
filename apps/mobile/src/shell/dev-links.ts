// 测试和测量用的链接（adb shell am start -a android.intent.action.VIEW -d '<链接>'），scripts/bench.mjs 和端到端验收靠它驱动：
//   litch://boot?mode=mock|fixture|stored        换核心的装法（记进设置，重新装一次）
//   litch://new?prompt=长回答[&device=<标识>]      新建会话并打开（设备不给：夹具装法用夹具那台，否则用第一台）
//   litch://open?session=<标识>|last[&device=…]  打开会话（last 是这次启动里最近新建的）
//   litch://send?text=短回答                       往最近新建的会话里再发一句
//   litch://home                                   回首页
//   litch://bench                                  WebView 吞吐测试
//   litch://remote?adapter=…&env=名=值             远程设备的开发参数（src/platform/dev.ts），验收接测试夹具用
//   litch://seed?count=300[&device=…]              建一批会话（量会话列表的滑动，只在模拟核心里用）
//   litch://terminal[?device=…&root=…&terminal=…&stats=1]  终端页（root 不给：夹具的工作目录，否则设备上第一个工作区的根）
//   litch://diff[?device=…&root=…&scope=all|staged|unstaged&session=…]  差异页（root 同上）
// 每个链接都可以带测量开关（src/experiment.ts）：render、seal、pace、freeze、tail、keyboard、markers，以及 probe=1|0。
import { keys } from '@litch/core'
import { createNavigationContainerRef, StackActions } from '@react-navigation/native'
import { experiment } from '../experiment'
import type { RootStackParamList } from '../nav/routes'
import { setRemoteDev } from '../platform/dev'
import { markOpen, startProbe, stopProbe } from '../probe'
import { seedSessions } from '../screens/sessions/seed'
import { termStats } from '../screens/tools/tool-flags'
import type { BootMode } from './boot'
import type { Services } from './services'

export const navigationRef = createNavigationContainerRef<RootStackParamList>()

function applyExperiment(params: URLSearchParams) {
  if (params.has('markers')) experiment.markers = params.get('markers') === '1'
  const render = params.get('render')
  if (render === 'md' || render === 'plain') experiment.render = render
  const seal = Number(params.get('seal'))
  if (seal > 0) experiment.seal = seal
  if (params.has('pace')) experiment.pace = Math.max(0, Number(params.get('pace')) || 0)
  if (params.has('freeze')) experiment.freeze = params.get('freeze') === '1'
  const tail = params.get('tail')
  if (tail === 'open' || tail === 'whole') experiment.tail = tail
  const keyboard = params.get('keyboard')
  if (keyboard === 'sticky' || keyboard === 'chat') experiment.keyboard = keyboard
  if (params.has('probe')) (params.get('probe') === '1' ? startProbe : stopProbe)()
}

let lastCreated: { deviceId: string; sessionId: string } | null = null

/** 链接里要换装法时返回新的装法，App 据此重新装核心；别的链接就地办完 */
export function handleDevLink(url: string, services: Services | null): BootMode | null {
  const parsed = new URL(url)
  const params = parsed.searchParams
  applyExperiment(params)
  if (parsed.hostname === 'remote') {
    setRemoteDev(params)
    return null
  }
  if (parsed.hostname === 'boot') {
    const mode = params.get('mode')
    return mode === 'mock' || mode === 'fixture' || mode === 'stored' ? mode : null
  }
  if (!services || !navigationRef.isReady()) return null
  const { channel, replica, booted } = services
  const deviceOf = () => {
    const asked = params.get('device')
    if (asked) return asked
    const ids = replica.store.get<string[]>(keys.devices) ?? []
    return ids[0] ?? null
  }
  switch (parsed.hostname) {
    case 'new': {
      const deviceId = deviceOf()
      if (!deviceId) return null
      const text = params.get('prompt') ?? '长回答'
      void channel
        .command('session.create', { deviceId, cwd: booted.work, text })
        .then(({ sessionId }) => {
          lastCreated = { deviceId, sessionId }
          navigationRef.navigate('Detail', { deviceId, sessionId, title: text })
        })
      return null
    }
    case 'open': {
      const asked = params.get('session')
      const target =
        asked === 'last'
          ? lastCreated
          : asked
            ? { deviceId: deviceOf() ?? '', sessionId: asked }
            : null
      if (!target?.deviceId) return null
      markOpen()
      navigationRef.navigate('Detail', {
        ...target,
        title: params.get('title') ?? target.sessionId,
      })
      return null
    }
    case 'send': {
      if (lastCreated)
        void channel.command('session.send', {
          ...lastCreated,
          text: params.get('text') ?? '短回答',
        })
      return null
    }
    case 'bench':
      navigationRef.navigate('Bench')
      return null
    case 'seed': {
      const deviceId = deviceOf()
      if (deviceId)
        void seedSessions(channel, replica.store, deviceId, Number(params.get('count')) || 300)
      return null
    }
    case 'terminal':
    case 'diff': {
      const deviceId = deviceOf()
      if (!deviceId) return null
      const firstRoot = replica.store.get<{ roots: string[] }[]>(keys.workspaces(deviceId))?.[0]
        ?.roots[0]
      const root = params.get('root') ?? booted.work ?? firstRoot ?? null
      if (parsed.hostname === 'terminal') {
        termStats.on = params.get('stats') === '1'
        const terminalId = params.get('terminal')
        navigationRef.navigate('Terminal', {
          deviceId,
          root,
          ...(terminalId ? { terminalId } : {}),
        })
      } else if (root) {
        const scope = params.get('scope')
        navigationRef.navigate('Diff', {
          deviceId,
          root,
          scope: scope === 'staged' || scope === 'unstaged' ? scope : 'all',
          sessionId: params.get('session'),
        })
      }
      return null
    }
    case 'home':
      if (navigationRef.canGoBack()) navigationRef.dispatch(StackActions.popToTop())
      return null
    default:
      return null
  }
}
