// 正式账号页的隔离夹具，只回应账号命令，不连接设备或模型。
import '../src/styles/index.css'
import { type CoreChannel, createReplica, type HarnessConfigTopicView } from '@litch/core'
import { createRoot } from 'react-dom/client'
import { setAppearance } from '../src/app/appearance.ts'
import { ServicesProvider } from '../src/app/services.tsx'
import { AccountsTab } from '../src/devices/hconfig/AccountsTab.tsx'

setAppearance({ lang: 'zh-CN' })
const state = { signedIn: false, fail: false, calls: [] as string[] }
const channel = {
  async command(name) {
    state.calls.push(name)
    if (state.fail) throw new Error('隔离登录失败')
    if (name === 'acp.auth.authenticate') {
      await new Promise((resolve) => setTimeout(resolve, 100))
      state.signedIn = true
    }
    if (name === 'acp.auth.logout') state.signedIn = false
    return {
      status: state.signedIn ? 'signedIn' : 'signedOut',
      logout: true,
      instruction: 'agy acp --login',
      methods: ['oauth-personal', 'oauth-business', 'gemini-api-key'].map((id) => ({
        id,
        name: id,
        type: 'agent',
        description: null,
      })),
    }
  },
} as CoreChannel
const view = {
  config: { data: { values: { authenticationMode: 'subscription' } } },
  providers: { data: null },
} as HarnessConfigTopicView
Object.assign(window, { __acpAuth: state })
const root = document.getElementById('root')
if (!root) throw new Error('账号夹具缺少挂载节点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica: createReplica(channel), shell: 'browser' }}>
    <main className="mng hc" style={{ maxWidth: 640, padding: 20 }}>
      <AccountsTab device={{ id: 'fixture' } as never} harnessId="agy" view={view} />
    </main>
  </ServicesProvider>,
)
