// 预览里的一块手机屏（iframe 里的 /?app=1&...）：先按地址上的参数定明暗和语言，再把场景的几步交给正式的页面栈。
// 跳页面用 navigationRef；测试链接交给 App 自己挂在 Linking 上的监听器（和手机上收到 litch:// 链接走同一条路），
// 核心还没装好时那边会自己稍后再试。
import { Linking } from 'react-native'
import type { RouteName } from '../nav/routes'
import { navigationRef } from '../shell/dev-links'
import { jsonFile } from '../shell/json-file'
import type { Prefs } from '../shell/services'
import { type SceneStep, sceneById } from './scenes.web.ts'

/** 地址上的参数写进设置（App 起来时读），场景里的明暗、语言就跟着地址走 */
export function applyPrefs(params: URLSearchParams): void {
  const file = jsonFile<Partial<Prefs>>('prefs.json')
  const patch: Partial<Prefs> = { boot: 'mock', autoUpdate: false }
  const appearance = params.get('appearance')
  if (appearance === 'light' || appearance === 'dark' || appearance === 'system')
    patch.appearance = appearance
  const lang = params.get('lang')
  if (lang === 'zh-CN' || lang === 'en') patch.lang = lang
  file.write({ ...(file.read() ?? {}), ...patch })
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function navigatorReady(): Promise<boolean> {
  for (let i = 0; i < 300; i++) {
    if (navigationRef.isReady()) return true
    await sleep(50)
  }
  return false
}

/** react-native-web 的 Linking 把监听器存在自己身上，用它的派发投递一条链接，和系统交来的一样 */
function deliver(url: string): void {
  const linking = Linking as unknown as {
    _dispatchEvent(event: string, data: { url: string }): void
  }
  linking._dispatchEvent('url', { url })
}

async function play(step: SceneStep): Promise<void> {
  if ('link' in step) {
    deliver(step.link)
    return
  }
  const navigate = navigationRef.navigate as (route: RouteName, params: unknown) => void
  navigate(step.nav, step.params)
}

export async function runScene(id: string | null): Promise<void> {
  const scene = sceneById(id)
  if (!scene || !(await navigatorReady())) return
  for (const step of scene.steps) {
    await play(step)
    // 让上一步的页面先挂上，返回键才回得到它
    await sleep(120)
  }
}
