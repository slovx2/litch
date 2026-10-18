// copy：在两台机器之间（或者一台里面）搬文件和目录（08 号设计 2.4）。
// 桌面端的核心在中间转：从一头分块读（小文件 fs/readFile，大的用脚本按段读），往另一头写
// （小文件 fs/writeFile，大的起一个 cat > 文件 的进程、分块写进它的标准输入，写一块等一块，不在核心里攒）。
// 桌面端那一头照访问范围挡：源在禁止位置里、目标落进禁止位置，直接回 blocked；
// 复制目录时源里的禁止位置不往下走、跳过，目标那边经符号链接绕进别处的也跳过，都在结果里写明。
import { MACHINE_ID, MACHINE_LIMITS } from '../../../../protocol/src/client-tools-machine.mjs'
import { decodeBase64, decodeUtf8 } from '../../text/bytes.mjs'
import {
  ArgumentError,
  approved,
  askView,
  asObject,
  blockedMessage,
  done,
  errorText,
  failed,
  type LookedPath,
  lookPath,
  type Outcome,
  type ToolKit,
} from './common.mjs'
import { inside, lastPart, parentOf } from './paths.mjs'
import {
  findPattern,
  type ListedEntry,
  parseListed,
  runScript,
  scriptCommand,
  splitBytes,
} from './scripts.mjs'
import type { MachineFacts, MachineTarget } from './types.mjs'

/** 每块多大 */
export const COPY_CHUNK = 4 * 1024 * 1024
/** 目录最多有这么多项 */
const COPY_ENTRIES = 100_000
/** 列目录的脚本输出最多收这么多 */
const COPY_LIST_COLLECT = 64 * 1024 * 1024

interface End {
  label: string
  target: MachineTarget
  facts: MachineFacts
  looked: LookedPath
}

function endArg(
  args: Record<string, unknown>,
  key: 'from' | 'to',
): { machine: string; path: string } {
  const value = args[key]
  if (!value || typeof value !== 'object') throw new ArgumentError(`${key} must be {machine, path}`)
  const { machine, path } = value as Record<string, unknown>
  if (typeof machine !== 'string' || !machine)
    throw new ArgumentError(`${key}.machine must be a machine id`)
  if (typeof path !== 'string' || !path) throw new ArgumentError(`${key}.path must be a path`)
  return { machine, path }
}

function targetFor(kit: ToolKit, machine: string): MachineTarget {
  const target = kit.context.target(machine)
  if (!target)
    throw new ArgumentError(
      `machine "${machine}" is unknown or offline. Call machines to list the machines you can operate.`,
    )
  return target
}

const sizeText = (bytes: number) =>
  bytes < 1024 * 1024 ? `${bytes} bytes` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

export async function copyTool(kit: ToolKit, raw: unknown): Promise<Outcome> {
  let summary = ''
  try {
    const args = asObject(raw)
    const from = endArg(args, 'from')
    const to = endArg(args, 'to')
    summary = `${from.machine}:${from.path} -> ${to.machine}:${to.path}`
    const source = await openEnd(kit, from)
    let dest = await openEnd(kit, to)
    summary = `${source.label}:${source.looked.path} -> ${dest.label}:${dest.looked.path}`
    if (source.looked.blocked) return failed('blocked', blockedMessage(source.looked), summary)
    if (dest.looked.blocked) return failed('blocked', blockedMessage(dest.looked), summary)
    const kind = source.looked.probe.type
    if (kind === 'm' || kind === 'l')
      return failed('failed', `${source.looked.path} does not exist.`, summary)
    if (kind === 'o')
      return failed('invalid', `${source.looked.path} is not a regular file or folder.`, summary)
    if (kind === 'f' && source.looked.probe.size == null)
      return failed('failed', `${source.looked.path} cannot be read (permission denied).`, summary)
    // 目标是个已有的目录（或者以斜杠结尾），就放进它里面，名字照源的
    if (dest.looked.probe.type === 'd' || to.path.endsWith('/')) {
      const inner = `${dest.looked.path === '/' ? '' : dest.looked.path}/${lastPart(source.looked.path)}`
      dest = { ...dest, looked: await lookPath(kit, dest.target, dest.facts, inner) }
      summary = `${source.label}:${source.looked.path} -> ${dest.label}:${dest.looked.path}`
      if (dest.looked.blocked) return failed('blocked', blockedMessage(dest.looked), summary)
    }
    if (kind === 'd' && dest.looked.probe.type === 'f')
      return failed(
        'invalid',
        `${dest.looked.path} is a file; cannot copy a folder over it.`,
        summary,
      )
    if (kind === 'f' && dest.looked.probe.type === 'd')
      return failed(
        'invalid',
        `${dest.looked.path} is a folder; cannot copy a file over it.`,
        summary,
      )
    const sameMachine = source.target.id === dest.target.id
    if (
      sameMachine &&
      kind === 'd' &&
      inside(source.looked.probe.real, dest.looked.probe.real, source.looked.icase)
    )
      return failed('invalid', 'Cannot copy a folder into itself.', summary)
    if (sameMachine && source.looked.probe.real === dest.looked.probe.real)
      return failed('invalid', 'Source and destination are the same file.', summary)

    // 复制到桌面端算“写”，从桌面端复制出去算“读”（3.2）
    const cls =
      dest.target.role === 'desktop'
        ? 'mutate'
        : source.target.role === 'desktop'
          ? 'read'
          : 'mutate'
    const refused = await approved(
      kit,
      {
        class: cls,
        ask: askView({
          action: 'copy',
          copy: {
            from: { machine: source.facts.name, path: source.looked.path },
            to: { machine: dest.facts.name, path: dest.looked.path },
          },
        }),
      },
      summary,
    )
    if (refused) return refused

    const plan =
      kind === 'f' ? filePlan(source.looked.probe.size ?? 0) : await treePlan(kit, source, dest)
    if (plan.total > MACHINE_LIMITS.copyBytes)
      return failed(
        'invalid',
        `That is ${sizeText(plan.total)}; copy moves at most ${sizeText(MACHINE_LIMITS.copyBytes)} at a time. Copy smaller parts.`,
        summary,
      )
    if (plan.tooMany)
      return failed(
        'invalid',
        `The folder has more than ${COPY_ENTRIES} entries. Copy smaller parts.`,
        summary,
      )

    const srcRoot = source.looked.probe.real
    const dstRoot = dest.looked.path
    if (kind === 'd')
      await dest.target.request('fs/createDirectory', { path: dstRoot, recursive: true })
    else
      await dest.target.request('fs/createDirectory', { path: parentOf(dstRoot), recursive: true })
    for (const dir of plan.dirs) {
      await dest.target.request('fs/createDirectory', {
        path: `${dstRoot}/${dir}`,
        recursive: true,
      })
    }
    let copied = 0
    let files = 0
    for (const file of plan.files) {
      if (kit.context.signal.aborted)
        throw new ArgumentError(`cancelled after copying ${files} files`)
      const src = file.rel ? `${srcRoot}/${file.rel}` : srcRoot
      const dst = file.rel ? `${dstRoot}/${file.rel}` : dstRoot
      copied += await copyFile(kit, source.target, src, dest.target, dst, file.size)
      files++
    }
    const notes: string[] = []
    if (plan.links.length)
      notes.push(`skipped ${plan.links.length} symbolic links: ${preview(plan.links)}`)
    if (plan.others.length)
      notes.push(`skipped ${plan.others.length} special files: ${preview(plan.others)}`)
    if (plan.blocked.length)
      notes.push(`skipped ${plan.blocked.length} blocked locations: ${preview(plan.blocked)}`)
    if (plan.through.length)
      notes.push(
        `skipped ${plan.through.length} files whose destination goes through a symbolic link on the desktop: ${preview(plan.through)}`,
      )
    const what = kind === 'd' ? `${files} files in ${plan.dirs.length + 1} folders` : '1 file'
    return done(
      `Copied ${what} (${copied} bytes) from ${source.label}:${source.looked.path} to ${dest.label}:${dstRoot}.${notes.length ? `\n${notes.join('\n')}` : ''}`,
      summary,
    )
  } catch (error) {
    if (error instanceof ArgumentError) return failed('invalid', error.message, summary)
    return failed('failed', `Could not copy: ${errorText(error)}`, summary)
  }
}

const preview = (items: string[]) =>
  items.length > 5 ? `${items.slice(0, 5).join(', ')}, …` : items.join(', ')

async function openEnd(kit: ToolKit, end: { machine: string; path: string }): Promise<End> {
  const target = targetFor(kit, end.machine)
  const facts = await target.facts()
  const looked = await lookPath(kit, target, facts, end.path)
  const label =
    target.role === 'desktop'
      ? MACHINE_ID.desktop
      : target.role === 'session'
        ? MACHINE_ID.session
        : target.id
  return { label, target, facts, looked }
}

interface Plan {
  dirs: string[]
  files: { rel: string; size: number }[]
  links: string[]
  others: string[]
  blocked: string[]
  through: string[]
  total: number
  tooMany: boolean
}

const filePlan = (size: number): Plan => ({
  dirs: [],
  files: [{ rel: '', size }],
  links: [],
  others: [],
  blocked: [],
  through: [],
  total: size,
  tooMany: false,
})

async function listTree(kit: ToolKit, target: MachineTarget, root: string, looked: LookedPath) {
  const prune = looked.rules.flatMap((rule) => [rule.real, rule.expanded]).map(findPattern)
  const result = await runScript(
    kit.runner,
    target,
    scriptCommand.list(root, null, looked.icase, prune),
    {
      collect: COPY_LIST_COLLECT,
      allowFail: true,
      timeoutMs: 300_000,
    },
  )
  const prefix = root === '/' ? '/' : `${root}/`
  const entries: (ListedEntry & { rel: string })[] = []
  for (const record of splitBytes(result.stdout, [0, 0x1e])) {
    const entry = parseListed(decodeUtf8(record))
    if (entry?.path.startsWith(prefix))
      entries.push({ ...entry, rel: entry.path.slice(prefix.length) })
  }
  return { entries, overflow: result.overflow }
}

async function treePlan(kit: ToolKit, source: End, dest: End): Promise<Plan> {
  const plan: Plan = {
    dirs: [],
    files: [],
    links: [],
    others: [],
    blocked: [],
    through: [],
    total: 0,
    tooMany: false,
  }
  const tree = await listTree(kit, source.target, source.looked.probe.real, source.looked)
  if (tree.overflow || tree.entries.length > COPY_ENTRIES) return { ...plan, tooMany: true }
  const icase = source.looked.icase
  const pruned = (path: string) =>
    source.looked.rules.some(
      (rule) => inside(rule.real, path, icase) || inside(rule.expanded, path, icase),
    )
  // 目标在桌面端、而且已经有东西时：那边的符号链接不许被穿过去（会写到链接指的地方）
  let destLinks: string[] = []
  if (dest.target.role === 'desktop' && dest.looked.probe.type === 'd') {
    const there = await listTree(kit, dest.target, dest.looked.probe.real, dest.looked)
    destLinks = there.entries.filter((entry) => entry.type === 'l').map((entry) => entry.rel)
  }
  const throughLink = (rel: string) =>
    destLinks.some((link) => rel === link || rel.startsWith(`${link}/`))
  for (const entry of tree.entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    if (pruned(entry.path)) {
      plan.blocked.push(entry.rel)
      continue
    }
    if (entry.type === 'l') plan.links.push(entry.rel)
    else if (entry.type === 'o') plan.others.push(entry.rel)
    else if (entry.type === 'd') {
      // 经链接的目录不建（建了就落到链接指的地方），里面的文件下面一个个记
      if (!throughLink(entry.rel)) plan.dirs.push(entry.rel)
    } else if (throughLink(entry.rel)) plan.through.push(entry.rel)
    else {
      plan.files.push({ rel: entry.rel, size: entry.size })
      plan.total += entry.size
    }
  }
  return plan
}

/** 搬一个文件，回搬了多少字节 */
async function copyFile(
  kit: ToolKit,
  from: MachineTarget,
  src: string,
  to: MachineTarget,
  dst: string,
  size: number,
): Promise<number> {
  if (size <= COPY_CHUNK) {
    const read = await from.request('fs/readFile', { path: src }, { timeoutMs: 120_000 })
    await to.request(
      'fs/writeFile',
      { path: dst, dataBase64: read.dataBase64 },
      { timeoutMs: 120_000 },
    )
    return decodeBase64(read.dataBase64).length
  }
  const writer = await kit.runner.run(to, scriptCommand.write(dst), {
    cwd: '/',
    stdin: true,
    timeoutMs: null,
  })
  let offset = 0
  try {
    while (offset < size) {
      if (kit.context.signal.aborted) throw new ArgumentError(`cancelled while copying ${src}`)
      const length = Math.min(COPY_CHUNK, size - offset)
      const chunk = await runScript(
        kit.runner,
        from,
        scriptCommand.readRange(src, offset, length),
        {
          collect: length,
          timeoutMs: 120_000,
        },
      )
      if (!chunk.stdout.length) break
      await writer.write(chunk.stdout)
      offset += chunk.stdout.length
    }
    await writer.write(new Uint8Array(0), true)
  } catch (error) {
    writer.kill()
    throw error
  }
  const exit = await writer.done
  if (exit.kind !== 'exited' || exit.exitCode !== 0)
    throw new ArgumentError(
      `writing ${dst} failed: ${decodeUtf8(exit.stderr).trim() || `exit code ${exit.exitCode}`}`,
    )
  if (offset !== size)
    throw new ArgumentError(`${src} changed while it was being copied (${offset} of ${size} bytes)`)
  return offset
}
