// 正式对话框、核心通道序列化与副本；只替换 SSH/设备，不连接真实用户设备。
import '../src/styles/index.css'
import {
  ChannelError,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type DeviceView,
  keys,
  type PairingAddressHints,
  type PairingHostKeyWarning,
  type PairingView,
  serveChannel,
} from '@litch/core'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ServicesProvider, useKey } from '../src/app/services.tsx'
import { browserClock } from '../src/boot/channel.ts'
import { PairDialog } from '../src/devices/PairDialog.tsx'
import '../src/app/appearance.ts'

const params = new URLSearchParams(location.search)
const core = createMockCore({
  clock: browserClock,
  chunkMs: 10000,
  pairTtlMs: Number(params.get('ttl') ?? 600000),
})
const originalCommand = core.command.bind(core)
const calls: { name: string; args: unknown }[] = []
let token: string | null = null
let seq = 0
const fingerprint = `SHA256:${'a'.repeat(43)}`
const scenario = params.get('address')
const scenarioHosts: Record<string, string> = {
  proxy: '10.10.10.10',
  private: '192.168.1.7',
  tailnet: '100.100.100.7',
  public: '203.0.113.7',
}
core.command = async (name, given, signal) => {
  calls.push({ name, args: given })
  if (name === 'pairing.start') {
    const args = given as {
      address?: { host: string; port: number; user: string }
      hostKeyConfirmation?: string
    }
    const host = scenario ? scenarioHosts[scenario] : undefined
    if (host) {
      const at = args.address ?? { host, port: 22, user: 'dev' }
      const hints: PairingAddressHints = {
        hosts: scenario === 'proxy' ? ['100.100.100.7'] : [],
        ...(scenario === 'proxy'
          ? { ssh: { host, port: 22, proxy: true, alias: 'demo-box' } }
          : {}),
      }
      if (scenario === 'proxy' && at.host === host && args.hostKeyConfirmation !== 'address-risk') {
        const key = { type: 'ssh-ed25519', publicKey: 'ssh-ed25519 ENTRY', fingerprint }
        throw new ChannelError('rejected', '需要确认', undefined, {
          key: 'hostKeyMismatch',
          pairingAddress: { name: '配对夹具', ...at },
          pairingAddressHints: hints,
          pairingHostKey: {
            token: 'address-risk',
            reason: 'unverified',
            address: at,
            reported: [key],
            known: [key],
            entrance: [],
            selected: key,
          },
        })
      }
      const result = (await originalCommand(name, { ...args, address: at }, signal)) as {
        pairing: PairingView
      }
      return { pairing: { ...result.pairing, ...hints } }
    }
    const failure = params.get('failure')
    if (failure && args.address?.port !== 2224) {
      throw new ChannelError('rejected', 'fixture SSH output', undefined, {
        key: failure,
        pairingAddress: { name: '配对夹具', host: '127.0.0.1', port: 2222, user: 'dev' },
      })
    }
    const accepted = !!token && args.hostKeyConfirmation === token
    token = null
    if (!accepted) {
      token = `warning-${++seq}`
      const key = { type: 'ssh-ed25519', publicKey: 'ssh-ed25519 ENTRY', fingerprint }
      const reason = (params.get('reason') as PairingHostKeyWarning['reason']) || 'mismatch'
      throw new ChannelError('rejected', '需要确认', undefined, {
        key: 'hostKeyMismatch',
        pairingHostKey: {
          token,
          reason,
          address: args.address ?? { host: '10.0.3.11', port: 22, user: 'dev' },
          reported: [{ ...key, fingerprint: `SHA256:${'b'.repeat(43)}` }],
          known: reason === 'unknown' ? [] : [key],
          entrance: reason === 'unverified' ? [] : [key],
          selected: key,
        },
      })
    }
  }
  return originalCommand(name, given, signal)
}
const [client, server] = createPortPair()
serveChannel(server, core, { clock: browserClock })
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
Object.assign(window, { pairHostFixture: { calls } })
function Fixture() {
  const device = useKey<DeviceView>(keys.device('build'))
  const [open, setOpen] = useState(true)
  return (
    <>
      <button type="button" data-reopen onClick={() => setOpen(true)}>
        打开夹具
      </button>
      {open && device ? <PairDialog device={device} onClose={() => setOpen(false)} /> : null}
    </>
  )
}
const root = document.getElementById('root')
if (!root) throw new Error('缺少夹具挂载点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <Fixture />
  </ServicesProvider>,
)
