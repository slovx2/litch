import type {
  AutomationPreviewCommand,
  AutomationPreviewOwner,
  AutomationPreviewPort,
  AutomationPreviewView,
} from '@litch/core'
import { AUTOMATION_PREVIEW } from './host.mjs'

export function automationPreviewPort(post: (message: unknown) => void) {
  let listener: Parameters<AutomationPreviewPort['listen']>[0] = () => {}
  let next = 0
  const waiting = new Map<
    number,
    { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  const port: AutomationPreviewPort = {
    listen(handler) {
      listener = handler
    },
    command(command: AutomationPreviewCommand) {
      const id = ++next
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(new Error('Preview command timed out'))
        }, 7000)
        waiting.set(id, { resolve, reject, timer })
        post({ type: AUTOMATION_PREVIEW, op: 'command', id, command })
      })
    },
  }
  return {
    port,
    receive(raw: unknown) {
      const message = raw as {
        type?: string
        op?: string
        id: number
        error?: string
        view: AutomationPreviewView | null
        owner: AutomationPreviewOwner
      } | null
      if (message?.type !== AUTOMATION_PREVIEW) return false
      if (message.op === 'view') listener(message.view, message.owner)
      else if (message.op === 'result') {
        const pending = waiting.get(message.id)
        if (pending) {
          waiting.delete(message.id)
          clearTimeout(pending.timer)
          if (message.error) pending.reject(new Error(message.error))
          else pending.resolve()
        }
      }
      return true
    },
  }
}
