// 一次性恢复：仅按会话现存 cwd 重建单目录项目，不能还原原来的项目组织。
// 默认只读打印计划；--apply 要求设备服务已停止，并先在线备份全部相关库和配置。
// node scripts/recover-device-projects.mjs --home ~/.codex-harness-adapter
// --inventory <JSON> 可在本机预览已取证的脱敏元数据，绝不允许搭配 --apply。
// --only <绝对目录> 可重复使用，只处理这些精确目录，不包含子目录。
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { backup, DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const APPLICATION_ID = 0x43484131
const read = (file, operation) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return operation(db)
  } finally {
    db.close()
  }
}
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()

function deviceInventory(db) {
  if (db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID)
    throw new Error('不是受支持的 Litch 设备库，保留原文件')
  return {
    version: db.prepare('PRAGMA user_version').get().user_version,
    threads: rows(db, 'threads'),
    projects: rows(db, 'projects'),
    memberships: rows(db, 'project_threads'),
  }
}

async function dshCwd(home, id) {
  const root = join(home, 'sessions')
  if (!fs.existsSync(root)) return null
  for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory() || basename(id) !== id) continue
    const file = join(root, directory.name, id, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(file)) continue
    // 只解第一行会话头，不读取或输出对话正文。
    const process = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'ignore'] })
    let failed
    process.on('error', (error) => {
      failed = error
      process.stdout.destroy(error)
    })
    const lines = createInterface({ input: process.stdout, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        const header = JSON.parse(line)
        return header.id === id && typeof header.cwd === 'string' ? header.cwd : null
      }
      if (failed) throw failed
    } finally {
      lines.close()
      process.kill()
    }
  }
  return null
}

export async function readInventory(home, codexDb, dshHome) {
  const inventory = read(join(home, 'device/device.sqlite'), deviceInventory)
  inventory.sources = []
  inventory.warnings = []
  const specs = [
    ['claude-code', join(home, 'claude-code/state.sqlite'), 'SELECT id,cwd FROM threads'],
    [
      'pi',
      join(home, 'pi/adapter.sqlite'),
      "SELECT id,json_extract(data,'$.cwd') AS cwd FROM threads",
    ],
    ['codex', codexDb, 'SELECT id,cwd FROM threads'],
  ]
  for (const [harness, file, sql] of specs) {
    if (!fs.existsSync(file)) {
      inventory.warnings.push(`没有找到 ${harness} 源库`)
      continue
    }
    for (const item of read(file, (db) => db.prepare(sql).all()))
      inventory.sources.push({ ...item, harness, source: file })
  }
  for (const thread of inventory.threads.filter((t) => t.harness === 'dsh')) {
    const cwd = await dshCwd(dshHome, thread.id)
    if (cwd)
      inventory.sources.push({ id: thread.id, harness: 'dsh', cwd, source: 'dsh session header' })
  }
  return inventory
}

export function planRecovery(inventory, { only = [] } = {}) {
  if (only.some((cwd) => !isAbsolute(cwd))) throw new Error('--only 必须是绝对目录')
  const selection = [...new Set(only)].sort()
  const existing = new Map(inventory.memberships.map((m) => [m.thread_id, m.project_id]))
  const sources = new Map()
  for (const item of inventory.sources) {
    const key = `${item.harness}\0${item.id}`
    const values = sources.get(key) ?? new Set()
    if (typeof item.cwd === 'string' && isAbsolute(item.cwd)) values.add(item.cwd)
    sources.set(key, values)
  }
  const groups = new Map(),
    skipped = []
  let assigned = 0,
    transient = 0,
    excluded = 0
  for (const thread of inventory.threads) {
    if (thread.ephemeral) {
      transient++
      continue
    }
    if (existing.has(thread.id)) {
      assigned++
      continue
    }
    const cwds = [...(sources.get(`${thread.harness}\0${thread.id}`) ?? [])]
    if (cwds.length !== 1) {
      skipped.push({ id: thread.id, harness: thread.harness, reason: 'cwd 缺失或冲突' })
      continue
    }
    const cwd = cwds[0]
    if (selection.length && !selection.includes(cwd)) {
      excluded++
      continue
    }
    const matching = inventory.projects.filter((p) =>
      JSON.parse(p.roots_json).some((r) => r.path === cwd),
    )
    if (matching.length > 1) {
      skipped.push({ id: thread.id, reason: '多个现有项目包含该目录' })
      continue
    }
    const group = groups.get(cwd) ?? {
      cwd,
      name: matching[0]?.name ?? (basename(cwd) || cwd),
      projectId: matching[0]?.id ?? null,
      threads: [],
    }
    group.threads.push({ id: thread.id, harness: thread.harness })
    groups.set(cwd, group)
  }
  // 按码点排序，跨 macOS/Linux 预览时摘要不受系统语言或 ICU 版本影响。
  const projects = [...groups.values()].sort((a, b) => (a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0))
  const plan = {
    mode: 'plan',
    schemaVersion: inventory.version,
    indexed: inventory.threads.length,
    alreadyAssigned: assigned,
    transient,
    excluded,
    selection,
    recoverable: projects.reduce((n, p) => n + p.threads.length, 0),
    createProjects: projects.filter((p) => !p.projectId).length,
    projects,
    skipped,
    warnings: inventory.warnings ?? [],
    limitations: [
      '只覆盖设备索引中的会话',
      '目录名代替原项目名',
      '不推断父目录或多根项目',
      '不恢复原项目 ID、分组、置顶、排序、元数据',
      '不推断或授予访问权限',
    ],
  }
  return { ...plan, digest: createHash('sha256').update(JSON.stringify(plan)).digest('hex') }
}

function assertStopped(home) {
  if (fs.existsSync(join(home, 'device/device.sock')))
    throw new Error('设备套接字仍存在，无法核实服务已停止，拒绝写入')
  const info = join(home, 'device/service.json')
  if (fs.existsSync(info)) {
    const pid = JSON.parse(fs.readFileSync(info, 'utf8')).pid
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') return
        throw error
      }
      throw new Error('设备服务仍在运行；请先审阅计划并人工停止服务，脚本不会停止服务')
    }
  }
}

export async function backupState(home) {
  const parent = `${home}-backups`
  const stamp = `project-recovery-${new Date().toISOString().replace(/[:.]/g, '-')}`
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  const target = fs.mkdtempSync(join(parent, `${stamp}-`))
  fs.chmodSync(target, 0o700)
  const files = []
  const visit = async (directory, depth = 0) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory() && depth < 1) {
        if (entry.name !== 'logs') await visit(file, depth + 1)
        continue
      }
      if (!entry.isFile() || !(/\.(sqlite|db|json)$/.test(entry.name) || entry.name === 'env'))
        continue
      const relative = file.slice(home.length + 1),
        destination = join(target, relative)
      fs.mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      if (/\.(sqlite|db)$/.test(entry.name)) {
        const db = new DatabaseSync(file, { readOnly: true })
        try {
          await backup(db, destination)
        } finally {
          db.close()
        }
        read(destination, (check) => {
          if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
            throw new Error(`备份校验失败：${relative}`)
        })
      } else fs.copyFileSync(file, destination)
      fs.chmodSync(destination, 0o600)
      files.push(relative)
    }
  }
  await visit(home)
  fs.writeFileSync(
    join(target, 'manifest.json'),
    JSON.stringify({ kind: 'project-recovery', complete: true, files }),
    { mode: 0o600 },
  )
  // 只轮换本工具完成并带清单的备份，不碰其他备份或未完成的目录。
  const completed = fs
    .readdirSync(parent)
    .filter((name) => {
      if (!/^project-recovery-\d{4}-\d{2}-\d{2}T[\dZ-]+-[a-zA-Z0-9]{6}$/.test(name)) return false
      const path = join(parent, name)
      if (fs.lstatSync(path).isSymbolicLink()) return false
      try {
        const m = JSON.parse(fs.readFileSync(join(path, 'manifest.json'), 'utf8'))
        return m.kind === 'project-recovery' && m.complete === true
      } catch {
        return false
      }
    })
    .sort()
    .reverse()
  for (const name of completed.slice(4)) fs.rmSync(join(parent, name), { recursive: true })
  return target
}

export async function applyRecovery(home, inventory, plan, expectedDigest) {
  if (expectedDigest !== plan.digest)
    throw new Error('必须用 --expect 提供已审阅计划的 digest；计划有变化时请重新审阅')
  if (inventory.version !== 4) throw new Error('仅处理已升级的 v4 设备库；旧库应先使用修复版迁移')
  assertStopped(home)
  if (!plan.recoverable) return { mode: 'applied', projects: 0, memberships: 0 }
  const backupDirectory = await backupState(home)
  assertStopped(home)
  const db = new DatabaseSync(join(home, 'device/device.sqlite'))
  try {
    db.exec('BEGIN IMMEDIATE')
    const fresh = { ...inventory, ...deviceInventory(db) }
    if (planRecovery(fresh, { only: plan.selection }).digest !== expectedDigest)
      throw new Error('备份期间设备数据发生变化，取消写入')
    const now = Math.floor(Date.now() / 1000)
    let position = Number(
      db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS n FROM projects').get().n,
    )
    for (const group of plan.projects) {
      const id = group.projectId ?? randomUUID()
      if (!group.projectId)
        db.prepare(
          'INSERT INTO projects(id,idempotency_key,name,roots_json,metadata_json,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          id,
          `recovery-${id}`,
          group.name,
          JSON.stringify([{ path: group.cwd }]),
          JSON.stringify({ 'litch.recovery': 'cwd' }),
          position++,
          now,
          now,
        )
      for (const thread of group.threads)
        db.prepare('INSERT INTO project_threads(thread_id,project_id) VALUES(?,?)').run(
          thread.id,
          id,
        )
    }
    db.exec('COMMIT')
    return {
      mode: 'applied',
      projects: plan.createProjects,
      memberships: plan.recoverable,
      backupDirectory,
    }
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      home: { type: 'string' },
      'codex-db': { type: 'string' },
      'dsh-home': { type: 'string' },
      inventory: { type: 'string' },
      apply: { type: 'boolean' },
      expect: { type: 'string' },
      only: { type: 'string', multiple: true },
    },
  })
  if (values.inventory && values.apply) throw new Error('离线取证清单只允许预览，不可用于写入')
  const home = resolve(values.home ?? join(homedir(), '.codex-harness-adapter'))
  const inventory = values.inventory
    ? JSON.parse(fs.readFileSync(values.inventory, 'utf8'))
    : await readInventory(
        home,
        resolve(values['codex-db'] ?? join(homedir(), '.codex/state_5.sqlite')),
        resolve(values['dsh-home'] ?? join(homedir(), '.dsh')),
      )
  const plan = planRecovery(inventory, { only: values.only })
  console.log(
    JSON.stringify(
      values.apply ? await applyRecovery(home, inventory, plan, values.expect) : plan,
      null,
      2,
    ),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
