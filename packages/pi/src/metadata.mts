import { randomUUID } from 'node:crypto'
import { ProtocolError, pageRecords, requiredString } from '../../shared/src/protocol-contract.mjs'
import { PINNED_SECTION, PINNED_SECTION_ID } from '../../shared/src/thread-sections.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import type { PiServer } from './server.mjs'

export function metadataRequest(s: PiServer, peer: RpcPeer, method: string, p: any): any {
  if (method.startsWith('thread/queue/')) {
    const thread = s.store.thread(p.threadId)
    let result: any = {}
    switch (method) {
      case 'thread/queue/list':
        return pageRecords(
          s.queue.list(thread.id),
          { ...p, sortDirection: 'asc' },
          `queue:${thread.id}`,
          (q) => q.id,
        )
      case 'thread/queue/add': {
        if (!Array.isArray(p.input) || !p.input.length)
          throw new ProtocolError(-32602, '队列输入不能为空')
        result = {
          queuedSubmission: s.queue.add(
            thread.id,
            requiredString(p.clientUserMessageId, 'clientUserMessageId'),
            p.input,
          ).item,
        }
        break
      }
      case 'thread/queue/update':
        result = { queuedSubmission: s.queue.update(thread.id, p.queuedSubmissionId, p.input) }
        break
      case 'thread/queue/delete':
        result = { deleted: s.queue.delete(thread.id, p.queuedSubmissionId) }
        break
      case 'thread/queue/reorder':
        s.queue.reorder(thread.id, p.queuedSubmissionIds)
        break
      case 'thread/queue/start': {
        if (s.active.has(thread.id)) throw new ProtocolError(-32009, '会话已有活动回合')
        s.store.setMeta('queue', thread.id, { paused: false })
        const first = s.queue.list(thread.id)[0]
        if (first) {
          const turn = s.start(peer, thread, {
            input: first.input,
            clientUserMessageId: first.clientUserMessageId,
            queuedSubmissionId: first.id,
          })
          result = { turn }
        }
        break
      }
      default:
        throw new ProtocolError(-32601, '未知队列操作')
    }
    s.notify(thread.id, 'thread/queue/changed', {})
    return result
  }
  if (method.startsWith('thread/attachment/')) {
    s.store.thread(p.threadId)
    const scope = `attachments:${p.threadId}`
    const rows = s.store.db
      .prepare('SELECT data FROM metadata WHERE scope=? ORDER BY id')
      .all(scope)
      .map((r) => JSON.parse(String(r.data)))
    if (method.endsWith('/list')) return pageRecords(rows, p, scope, (r) => r.id)
    const attachmentType = requiredString(p.attachmentType, 'attachmentType'),
      identityKey = requiredString(p.identityKey, 'identityKey')
    const old = rows.find(
      (r) => r.attachmentType === attachmentType && r.identityKey === identityKey,
    )
    if (method.endsWith('/add')) {
      if (p.payload === undefined) throw new ProtocolError(-32602, '缺少 payload')
      if (old) return { outcome: 'existing', attachment: old }
      const attachment = {
        id: randomUUID(),
        attachmentType,
        identityKey,
        payload: p.payload,
        createdAt: Math.floor(Date.now() / 1000),
      }
      s.store.setMeta(scope, attachment.id, attachment)
      s.notify(p.threadId, 'thread/attachment/updated', {
        attachmentType,
        identityKey,
        attachmentId: attachment.id,
        operation: 'created',
      })
      return { outcome: 'created', attachment }
    }
    if (method.endsWith('/remove')) {
      if (old) {
        s.store.db.prepare('DELETE FROM metadata WHERE scope=? AND id=?').run(scope, old.id)
        s.notify(p.threadId, 'thread/attachment/updated', {
          attachmentType,
          identityKey,
          attachmentId: old.id,
          operation: 'deleted',
        })
      }
      return {}
    }
  }
  if (method === 'thread/metadata/update' || method === 'thread/section/move') {
    s.store.thread(p.threadId)
    const data = s.store.getMeta('thread', p.threadId) ?? {}
    if (method === 'thread/section/move') {
      if (p.sectionId !== null && typeof p.sectionId !== 'string')
        throw new ProtocolError(-32602, 'sectionId 必须为字符串或 null')
      if (
        p.sectionId &&
        p.sectionId !== PINNED_SECTION_ID &&
        !s.store.getMeta('section', p.sectionId)
      )
        throw new ProtocolError(-32602, '未知分组')
      data.sectionId = p.sectionId
      data.isPinned = p.sectionId === PINNED_SECTION_ID
      data.sectionEnteredAt = Math.floor(Date.now() / 1000)
    } else if (typeof p.isPinned === 'boolean') {
      data.isPinned = p.isPinned
      data.sectionId = p.isPinned ? PINNED_SECTION_ID : null
    }
    s.store.setMeta('thread', p.threadId, data)
    if (method === 'thread/metadata/update') {
      if (typeof p.daybreakEnabled === 'boolean') data.daybreakEnabled = p.daybreakEnabled
      if (p.gitInfo && typeof p.gitInfo === 'object')
        data.gitInfo = { ...(data.gitInfo ?? {}), ...p.gitInfo }
      if (typeof p.projectId === 'string') s.projects.assignThread(p.threadId, p.projectId || null)
      s.store.setMeta('thread', p.threadId, data)
      return { thread: s.envelope(s.store.thread(p.threadId), false) }
    }
    return {}
  }
  if (method.startsWith('threadSection/')) {
    const rows = s.store.db
      .prepare("SELECT data FROM metadata WHERE scope='section' ORDER BY id")
      .all()
      .map((r) => JSON.parse(String(r.data)))
    // 内置置顶分组始终存在，与桌面使用的固定 ID 一致。
    if (method === 'threadSection/list')
      return pageRecords([PINNED_SECTION, ...rows], p, 'sections', (r) => r.id)
    if (method === 'threadSection/create') {
      const section = {
        id: randomUUID(),
        name: requiredString(p.name, 'name'),
        appearance: p.appearance ?? null,
      }
      s.store.setMeta('section', section.id, section)
      return { section }
    }
    if (p.sectionId === PINNED_SECTION_ID)
      throw new ProtocolError(-32602, '内置置顶分组不可修改或删除')
    const section = s.store.getMeta('section', p.sectionId)
    if (!section) throw new ProtocolError(-32602, '未知分组')
    if (method === 'threadSection/update') {
      Object.assign(section, {
        name: p.name ?? section.name,
        appearance: p.appearance ?? section.appearance,
      })
      s.store.setMeta('section', section.id, section)
      return { section }
    }
    if (method === 'threadSection/delete') {
      s.store.db.prepare("DELETE FROM metadata WHERE scope='section' AND id=?").run(section.id)
      for (const thread of s.store.threads()) {
        const data = s.store.getMeta('thread', thread.id)
        if (data?.sectionId === section.id)
          s.store.setMeta('thread', thread.id, { ...data, sectionId: null })
      }
      return {}
    }
  }
  throw new ProtocolError(-32601, `Pi 不支持 ${method}`)
}
