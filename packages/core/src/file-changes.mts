import type { CoreChannel } from './channel/client.mjs'

/** 订阅期间串行重读；读取途中再变更只补读一次，关闭后不再启动读取。 */
export function observeFileChanges(
  channel: CoreChannel,
  location: { deviceId: string; root: string; path: string; directory?: boolean },
  reload: () => Promise<unknown>,
  initial = false,
): () => void {
  let closed = false
  let running = false
  let dirty = false
  const run = async () => {
    if (closed || running) return
    running = true
    try {
      while (dirty && !closed) {
        dirty = false
        await reload()
      }
    } finally {
      running = false
    }
  }
  const close = channel.subscribe(
    { kind: 'fileChanges', ...location },
    {
      snapshot({ revision }) {
        if (!revision) return
        dirty = true
        void run().catch(() => {})
      },
      delta() {},
    },
  )
  if (initial) {
    dirty = true
    void run().catch(() => {})
  }
  return () => {
    closed = true
    close()
  }
}
