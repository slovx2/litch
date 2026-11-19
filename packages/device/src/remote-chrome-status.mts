// CLI 取常驻设备自己的握手状态；服务没运行时，准备状态仍可单独诊断。
import { join } from 'node:path'
import {
  REMOTE_CHROME_CONFIGURE,
  REMOTE_CHROME_STATUS,
  type RemoteChromePolicy,
  type RemoteChromePolicyChange,
  type RemoteChromeStatus,
} from '../../protocol/src/remote-chrome.mjs'
import { unixConnector } from './sockets.mjs'
import type { Frame, Wire } from './wire.mjs'

export function readDeviceChromeStatus(stateDir: string): Promise<RemoteChromeStatus | null> {
  return callDevice<RemoteChromeStatus>(stateDir, REMOTE_CHROME_STATUS, {}).catch(() => null)
}

export async function configureDeviceChrome(
  stateDir: string,
  proof: string,
  change: RemoteChromePolicyChange,
) {
  const result = await callDevice<RemoteChromePolicy>(stateDir, REMOTE_CHROME_CONFIGURE, {
    ...change,
    proof,
  })
  if (!result)
    throw new Error(
      'The device Chrome bridge is unavailable. Start the device service and enable Chrome.',
    )
  return result
}

function callDevice<T>(stateDir: string, method: string, params: unknown): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let wire: Wire | null = null
    let finished = false
    const finish = (status: T | null, error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      wire?.close()
      if (error) reject(error)
      else resolve(status)
    }
    const timer = setTimeout(() => finish(null), 4000).unref()
    const send = (frame: Frame) => wire?.send(JSON.stringify(frame))
    unixConnector(join(stateDir, 'device.sock'))({
      message(raw) {
        let frame: Frame
        try {
          frame = JSON.parse(raw)
        } catch {
          return
        }
        if (frame.id === 1) {
          if (frame.error) return finish(null)
          send({ method: 'initialized' })
          send({ id: 2, method, params })
        }
        if (frame.id === 2)
          finish(
            frame.error ? null : (frame.result as T),
            frame.error ? new Error(frame.error.message) : undefined,
          )
      },
      close: () => finish(null),
    }).then(
      (opened) => {
        if (finished) return opened.close()
        wire = opened
        send({
          id: 1,
          method: 'initialize',
          params: {
            clientInfo: { name: 'litch-chrome-cli', version: '1' },
            capabilities: { litchExtensions: ['harness', 'remoteChrome'] },
          },
        })
      },
      () => finish(null),
    )
  })
}
