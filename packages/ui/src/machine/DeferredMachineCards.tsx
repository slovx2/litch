import type { MachineActivityView } from '@litch/core'
import { useEffect, useState } from 'react'
import type { MachineApprovalCard } from '../../../protocol/src/machine-approvals.mts'
import { useT } from '../app/appearance.ts'
import { useServices } from '../app/services.tsx'
import { MachineDeferredCard } from './MachineCard.tsx'

export function DeferredMachineCards({
  deviceId,
  sessionId,
}: {
  deviceId: string
  sessionId: string
}) {
  const { channel } = useServices()
  const t = useT()
  const [activity, setActivity] = useState<MachineActivityView>()
  const [mirrored, setMirrored] = useState<MachineApprovalCard[]>([])
  useEffect(
    () =>
      channel.subscribe(
        { kind: 'machine' },
        {
          snapshot: setActivity,
          delta: (ops) => {
            const last = ops.at(-1)
            if (last) setActivity(last.view)
          },
          error: () => setActivity(undefined),
        },
      ),
    [channel],
  )
  useEffect(() => {
    setMirrored([])
    return channel.subscribe(
      { kind: 'machineApprovals', deviceId },
      {
        snapshot: setMirrored,
        delta: () => {},
        error: () => setMirrored([]),
      },
    )
  }, [channel, deviceId])
  const local = (activity?.deferred ?? []).filter(
    (entry) => entry.deviceId === deviceId && entry.threadId === sessionId,
  )
  const localIds = new Set(local.map((entry) => entry.id))
  const remote = mirrored.filter((entry) => entry.threadId === sessionId && !localIds.has(entry.id))
  if (!local.length && !remote.length) return null
  return (
    <div className="req-slot" data-machine-deferred-slot>
      {local.map((entry) => (
        <MachineDeferredCard key={entry.id} entry={entry} />
      ))}
      {remote.map((entry) => (
        <section className="req mach-card" key={entry.id} data-machine-deferred-readonly>
          <div className="req-head">{t('machine.deferred.waiting')}</div>
          <div className="req-body">
            <code>{entry.target}</code>
            <p>{t('machine.deferred.onMac', { name: entry.desktop })}</p>
          </div>
        </section>
      ))}
    </div>
  )
}
