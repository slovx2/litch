import type { RemoteTarget } from '@litch/core'
import { useEffect, useState } from 'react'
import { native } from '../../modules/litch-ssh/src/native'

export function useConnectionRoute(
  target: RemoteTarget | null | undefined,
  state: string | undefined,
) {
  const [route, setRoute] = useState<'system' | 'tailscale' | null>(null)
  const host = target?.kind === 'host' ? target.host : null
  const port = target?.kind === 'host' ? (target.port ?? 22) : 22
  const mode = target?.kind === 'host' ? (target.tailscale ?? 'auto') : 'auto'
  useEffect(() => {
    let active = true
    setRoute(null)
    if (host && state)
      void native
        .connectionRoute(host, port, mode)
        .then((value) => {
          if (active) setRoute(value === 'system' || value === 'tailscale' ? value : null)
        })
        .catch(() => {})
    return () => {
      active = false
    }
  }, [host, port, mode, state])
  return route
}
