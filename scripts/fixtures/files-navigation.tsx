// 正式两端文件页的隔离夹具；传输接真实临时文件或回环 SSH，导航替身只记录 push/replace。

import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RpcError } from '../../packages/core/src/connection/rpc.mts'
import { channelFailure } from '../../packages/core/src/device/faults.mts'
import { createFiles } from '../../packages/core/src/device/files.mts'
import {
  fileBrowserKey,
  fileBrowserRoot,
  keys,
  textToBase64,
} from '../../packages/core/src/index.mts'
import { createFileTrees } from '../../packages/core/src/replica/file-trees.mts'
import { KeyedStore } from '../../packages/core/src/replica/keyed-store.mts'
import { ServicesProvider } from '../../packages/ui/src/app/services.tsx'
import { FilesTab } from '../../packages/ui/src/files/FilesTab.tsx'
import { openInFiles } from '../../packages/ui/src/files/state.ts'

const config = (window as any).__filesConfig
const store = new KeyedStore()
const seen: unknown[] = []
const files = createFiles({
  clock: {
    now: Date.now,
    setTimer(fn, ms) {
      const id = setTimeout(fn, ms)
      return () => clearTimeout(id)
    },
  },
  online: () => true,
  platform: () => 'macos',
  home: () => config.home,
  knownRoot: () => false,
  browserSupported: () => true,
  previewSupported: () => true,
  log() {},
  fail: channelFailure,
  async request(method, params) {
    seen.push({ method, params })
    const result = await fetch('/files-navigation-rpc', {
      method: 'POST',
      body: JSON.stringify({ method, params }),
    }).then((r) => r.json())
    if (result.error) throw new RpcError(result.error.code, result.error.message, result.error.data)
    return result.value
  },
})
const channel = {
  subscribe() {
    return () => {}
  },
  command(name: string, p: any) {
    if (name === 'files.resolve') return files.resolve(p.root, p.ref, p.href)
    if (name === 'files.read') return files.read(p.root, p.path)
    if (name === 'files.list') return files.list(p.root, p.path, p.fresh ?? false)
    if (name === 'folders.list') return files.folders(p.path)
    if (name === 'files.preview') return files.preview(p.root, p.path, p.format)
    if (name === 'files.requests') return Promise.resolve(files.requests())
    if (name === 'files.reconcile') return Promise.resolve()
    if (name === 'files.search') throw Error('临时目录不能递归搜索')
    return Promise.reject(Error(name))
  },
}
const replica = { store, files: createFileTrees(channel as any, store) }
store.set(keys.device('fixture'), {
  id: 'fixture',
  name: config.remote ? '回环 SSH 设备' : '隔离本机设备',
  os: 'macos',
  kind: config.remote ? 'ssh' : 'local',
  connection: 'online',
})
store.set(keys.workspaces('fixture'), [{ id: 'project', roots: [config.project] }])
for (const id of ['one', 'two'])
  store.set(keys.summary('fixture', id), { id, cwd: config.project, workspaceId: 'project' })

function Desktop() {
  const [sessionId, setSession] = useState('one')
  ;(window as any).__filesNav.session = setSession
  return (
    <ServicesProvider value={{ channel, replica, shell: 'browser' } as any}>
      <div style={{ height: 760, display: 'flex', flexDirection: 'column' }}>
        <FilesTab
          shown
          place={{
            deviceId: 'fixture',
            workspaceId: 'project',
            roots: [config.project],
            cwd: config.project,
            sessionId,
          }}
        />
      </div>
    </ServicesProvider>
  )
}

;(window as any).__filesNav = {
  config,
  seen,
  channel,
  replica,
  root: (sessionId = 'one') =>
    fileBrowserRoot(fileBrowserKey('fixture', sessionId, 'project'), config.project),
  open: (path: string, kind: 'file' | 'directory' = 'file') =>
    openInFiles({
      deviceId: 'fixture',
      workspaceId: 'project',
      sessionId: 'one',
      root: kind === 'directory' ? path : path.slice(0, path.lastIndexOf('/')),
      path,
      kind,
    }),
  async resolve(path: string) {
    return files.resolve(config.project, { path, line: null, alt: null }, path)
  },
  textToBase64,
}
const element = document.createElement('div')
element.id = 'files-navigation-fixture'
document.body.replaceChildren(element)
createRoot(element).render(<Desktop />)
