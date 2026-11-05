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
  type PairingHostKeyWarning,
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
core.command = async (name, given, signal) => {
  calls.push({ name, args: given })
  if (name === 'pairing.start') {
    const args = given as {
      address?: { host: string; port: number; user: string }
      hostKeyConfirmation?: string
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
