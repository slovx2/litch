// 仅接受自己生成的 JSON 夹具；状态、工作线和引擎全部在 treeRig 临时目录中。
import { treeRig } from '../packages/device/dist/device/test/tree-kit.mjs'

export function managerPagingRig(data, scale = 1) {
  const env = treeRig()
  const owner = env.device.managers
  const manager = {
    ...data.manager,
    cwd: env.stateDir,
    contact: { ...data.manager.contact, desktopNotification: false },
  }
  owner.kick = () => {}
  owner.store.saveManager(manager)
  owner.store.transaction(() => {
    const insert = owner.store.db.prepare('INSERT INTO changes(manager_id,body) VALUES(?,?)')
    for (let batch = 0; batch < scale; batch++) {
      const idOf = (id) => `${id[0]}-${Number(id.slice(2)) + batch * 1000}`
      for (const object of [...data.board.decisions, ...data.board.items])
        owner.store.saveObject(manager.id, { ...object, id: idOf(object.id) })
      for (const change of [...data.board.changes].reverse())
        insert.run(manager.id, JSON.stringify({ ...change, objectId: idOf(change.objectId) }))
    }
  })
  for (const line of data.board.lines)
    env.device.sessionTree.store.addLineage({
      threadId: line.threadId,
      parentThreadId: manager.threadId,
      harness: 'pi',
      kind: 'fresh',
      origin: 'model',
      title: line.title,
      prompt: '隔离工作线',
      wakeParent: false,
      createdAt: 1_800_000_000,
      proposalId: null,
    })
  let lineReads = 0
  env.device.sessionTree.read = async (id) => {
    lineReads++
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { thread: { id, status: { type: 'idle' }, cwd: env.stateDir } }
  }
  return { env, owner, manager, lineReads: () => lineReads }
}
