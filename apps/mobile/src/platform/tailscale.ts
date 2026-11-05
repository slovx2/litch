import { native } from '../../modules/litch-ssh/src/native'

export interface TailscaleStatus {
  state: 'stopped' | 'starting' | 'needsLogin' | 'needsApproval' | 'connected' | 'suspended'
  hostname: string
  tailnet: string
  authURL: string
  controlURL: string
}

export function tailscaleAvailable(): boolean {
  try {
    return native.tailscaleAvailable() === true
  } catch {
    return false
  }
}

export function controlURL(value: string): string {
  const input = value.trim()
  if (!input) return ''
  try {
    const url = new URL(input)
    if (
      url.protocol === 'https:' &&
      url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    ) {
      return url.toString().replace(/\/$/, '')
    }
  } catch {
    /* 统一给出控制服务器错误。 */
  }
  throw new Error('[tailscaleControl] HTTPS required')
}

const ERROR_KEYS = {
  tailscaleUnavailable: 'tailscale.unavailable',
  tailscaleLogin: 'tailscale.error.login',
  tailscaleAddress: 'tailscale.error.address',
  tailscaleStorage: 'tailscale.error.storage',
  tailscaleControl: 'tailscale.error.control',
  tailscaleStart: 'tailscale.error.start',
  tailscalePaused: 'tailscale.error.paused',
  tailscaleApproval: 'tailscale.error.approval',
  tailscaleConnecting: 'tailscale.error.connecting',
  tailscaleConnect: 'tailscale.error.connect',
  tailscaleLoginTimeout: 'tailscale.error.timeout',
  tailscaleAutoLogin: 'tailscale.error.switch',
} as const

export function tailscaleErrorKey(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  const code = text.match(/\[(tailscale\w+)\]/)?.[1]
  return code && code in ERROR_KEYS ? ERROR_KEYS[code as keyof typeof ERROR_KEYS] : null
}

export const tailscale = {
  status: async (): Promise<TailscaleStatus> => JSON.parse(await native.tailscaleStatus()),
  login: async (server: string): Promise<TailscaleStatus> =>
    JSON.parse(await native.tailscaleLogin(controlURL(server))),
  logout: () => native.tailscaleLogout(),
  clear: () => native.tailscaleClear(),
}
