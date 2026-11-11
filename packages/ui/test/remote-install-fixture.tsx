// 正式添加页、核心安装流程；仅 SSH 能力是假远程，名字和地址均虚构。
import {
  type Clock,
  connectChannel,
  createCore,
  createPortPair,
  createReplica,
  keys,
  phrase,
  serveChannel,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import { ServicesProvider } from '../src/app/services.tsx'
import { AddDevice } from '../src/devices/AddDevice.tsx'
import '../src/styles/index.css'

const clock: Clock = {
  now: Date.now,
  setTimer(fn, ms) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const mode = new URLSearchParams(location.search).get('mode')
const calls: string[] = []
let running = false
const core = createCore({
  version: '1.2.3',
  clock,
  devices: [],
  remote: {
    opener: () => async () => {
      throw Error('此验收不打开真实连接')
    },
    discover: async () => [
      { alias: 'atlas-lab', host: 'atlas.example.invalid', user: null, port: null },
    ],
    check: async () =>
      running
        ? {
            ok: true,
            peer: 'service',
            version: '1.2.3',
            system: 'Linux',
            running: true,
            harnesses: [],
          }
        : {
            ok: false,
            failure: {
              stage: 'notInstalled',
              text: phrase('remote.notInstalled'),
              detail: null,
              retrying: false,
              guide: 'install',
            },
          },
    setup: {
      prepare() {
        const step = async (name: string) => {
          calls.push(name)
          await new Promise((done) => setTimeout(done, 120))
          if (mode === 'failure' && name === 'download')
            throw Error('fixture: download unavailable (HTTP 503)')
        }
        return {
          inspect: async () => {
            calls.push('inspect')
            return mode === 'fetch' ? 'fetch' : mode === 'system' ? 'system' : null
          },
          download: () => step('download'),
          install: () => step('install'),
          start: async () => {
            await step('start')
            running = true
          },
          clean: async () => {
            calls.push('clean')
          },
        }
      },
    },
  },
})
const [client, server] = createPortPair()
serveChannel(server, core, { clock })
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
Object.assign(window, {
  installFixture: { calls, devices: () => replica.store.get<string[]>(keys.devices) ?? [] },
})
createRoot(document.getElementById('root')!).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <AddDevice edit={null} onClose={() => {}} />
  </ServicesProvider>,
)
