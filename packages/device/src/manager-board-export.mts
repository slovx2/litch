// 从旧版本设备状态只读导出。不启动设备、不调用 harness，也不打开凭据库。
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { boardSuggestions, exportManagerBoard } from './manager-board-transfer.mjs'
import { ManagerStore } from './manager-store.mjs'
import { SessionStore } from './session-store.mjs'

function run() {
  const [state, id] = process.argv.slice(2)
  if (!state || !id) throw new Error('需要设备状态目录和经理 ID。')
  const manager = new DatabaseSync(join(state, 'manager.sqlite'), { readOnly: true })
  try {
    const sessions = new DatabaseSync(join(state, 'sessions.sqlite'), { readOnly: true })
    try {
      manager.exec('BEGIN')
      sessions.exec('BEGIN')
      const store = new ManagerStore(manager)
      const archive = exportManagerBoard(
        store,
        id,
        boardSuggestions(store, new SessionStore(sessions), id),
      )
      process.stdout.write(JSON.stringify(archive))
    } finally {
      sessions.close()
    }
  } finally {
    manager.close()
  }
}

try {
  run()
} catch {
  process.exitCode = 1
}
