// 只有本机系统保存对话框能产生目标路径；按发起窗口隔离取消与打开操作。
import { basename, isAbsolute } from 'node:path'
import type { FileSaveProgress, FileSaveRequest } from '@litch/core'
import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'

const SAVE = 'litch:file-save'
export interface SaveMainHost {
  isUiUrl(url: string): boolean
  send(message: unknown): boolean
  fixture?: string
}
export function installFileSave(host: SaveMainHost) {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('context-menu', (_menu, params) => {
      // sandbox 文档内的右键不会冒泡到父页面；只传本机 UI 子框架中的坐标。
      if (
        host.isUiUrl(contents.mainFrame.url) &&
        params.frame &&
        params.frame !== contents.mainFrame
      ) {
        contents.send(`${SAVE}:context`, { x: params.x, y: params.y })
      }
    })
  })
  const owners = new WeakSet<WebContents>()
  const jobs = new Map<
    string,
    { owner: WebContents; request: FileSaveRequest; progress: FileSaveProgress; picking: boolean }
  >()
  const publish = (job: ReturnType<typeof jobs.get>, value: FileSaveProgress) => {
    if (!job) return
    job.progress = value
    if (!job.owner.isDestroyed()) job.owner.send(SAVE, value)
  }
  const cancel = (id: string) => {
    const job = jobs.get(id)
    if (job?.progress.state !== 'saving') return
    host.send({ type: 'file-save', op: 'cancel', id })
    if (job.picking) publish(job, { ...job.progress, state: 'cancelled' })
  }
  ipcMain.handle(SAVE, async (event, raw: unknown) => {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || !host.isUiUrl(frame.url))
      throw Error('Invalid caller')
    const request = raw as FileSaveRequest
    if (
      !request ||
      !['id', 'deviceId', 'root', 'path'].every(
        (key) =>
          typeof request[key as keyof FileSaveRequest] === 'string' &&
          request[key as keyof FileSaveRequest].length > 0,
      ) ||
      !/^[\w-]{1,128}$/.test(request.id)
    )
      throw Error('Invalid file request')
    if (
      jobs.has(request.id) ||
      [...jobs.values()].filter((job) => job.progress.state === 'saving').length >= 2
    )
      throw Error('Too many file transfers')
    const job = {
      owner: event.sender,
      request,
      progress: {
        id: request.id,
        state: 'saving' as const,
        bytes: 0,
        total: null,
        destination: '',
      } as FileSaveProgress,
      picking: true,
    }
    jobs.set(request.id, job)
    // 清理旧结果；进行中的任务一直保留到结束。
    for (const [id, old] of jobs) {
      if (jobs.size <= 32) break
      if (old.progress.state !== 'saving') jobs.delete(id)
    }
    if (!owners.has(event.sender)) {
      owners.add(event.sender)
      event.sender.once('destroyed', () => {
        for (const [id, entry] of jobs)
          if (entry.owner === event.sender) {
            cancel(id)
            jobs.delete(id)
          }
      })
    }
    try {
      const window = BrowserWindow.fromWebContents(event.sender)
      const settings: Electron.SaveDialogOptions = {
        defaultPath: basename(request.path.replaceAll('\\', '/')),
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      }
      const chosen =
        host.fixture !== undefined
          ? { canceled: !host.fixture, filePath: host.fixture }
          : window
            ? await dialog.showSaveDialog(window, settings)
            : await dialog.showSaveDialog(settings)
      job.picking = false
      if (
        job.progress.state === 'cancelled' ||
        chosen.canceled ||
        !chosen.filePath ||
        job.owner.isDestroyed()
      ) {
        publish(job, { ...job.progress, state: 'cancelled' })
        return
      }
      if (!isAbsolute(chosen.filePath)) throw Error('Invalid local destination')
      job.progress.destination = chosen.filePath
      publish(job, job.progress)
      if (
        !host.send({
          type: 'file-save',
          op: 'start',
          id: request.id,
          source: { deviceId: request.deviceId, root: request.root, path: request.path },
          destination: chosen.filePath,
        })
      )
        throw Error('Core is unavailable')
    } catch (error) {
      publish(job, {
        ...job.progress,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
  ipcMain.handle(`${SAVE}:action`, async (event, id: unknown, action: unknown) => {
    const frame = event.senderFrame
    if (
      !frame ||
      frame !== event.sender.mainFrame ||
      !host.isUiUrl(frame.url) ||
      typeof id !== 'string'
    )
      return
    const job = jobs.get(id)
    if (!job || job.owner !== event.sender) return
    if (action === 'cancel') {
      cancel(id)
      return
    }
    if (job.progress.state !== 'saved') return
    if (action === 'reveal') shell.showItemInFolder(job.progress.destination)
    if (action === 'open') {
      const error = await shell.openPath(job.progress.destination)
      if (error) throw Error(error)
    }
  })
  return {
    receive(raw: unknown): boolean {
      const message = raw as { type?: string; progress?: FileSaveProgress } | null
      if (message?.type !== 'file-save' || !message.progress) return false
      const job = jobs.get(message.progress.id)
      if (job && job.progress.state === 'saving')
        publish(job, { ...message.progress, destination: job.progress.destination })
      return true
    },
    disconnected() {
      for (const job of jobs.values())
        if (job.progress.state === 'saving')
          publish(job, { ...job.progress, state: 'failed', error: 'Core disconnected' })
    },
  }
}
