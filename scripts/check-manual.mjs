// 产品手册（skills/litch-manual）的检查，npm run check 会带上它：
//   1. SKILL.md 的头部：只有 name、description 两项，各占一行；name 是 litch-manual、和目录同名、合各家的格式；
//      description 不空、不超过 1024 个字、没有尖括号（Claude 不收带 XML 标签的描述）、中英文都有。
//      这几条取的是 Claude Code、Codex、Pi 等几家要求的交集，见下面的常量。
//   2. 对照 packages/protocol/src/config-ops.mts：每个操作在手册里都以 `scripts/litch <组> <动作>` 的样子出现过；
//      手册里写成这个样子的，组和动作都得存在（多讲了不存在的操作也报）。
//   3. SKILL.md 里提到的 references/*.md 都在，references 下的每一份 SKILL.md 都提到了。
//   4. 两个命令壳里留着 {{ADAPTER}}（安装时换成适配器的绝对路径），litch 可执行，litch.cmd 是 CRLF。
//   5. 手册是要公开装到用户机器上的：不许出现工作区的路径和内部决策编号。
//   6. references/harnesses.md 里写的“验证过的版本”和 protocol/versions.json 对得上（那边改了这边要跟）。
//
//   node scripts/check-manual.mjs [手册目录]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_OPS, configOpName } from '../packages/protocol/src/config-ops.mts'

const repo = fileURLToPath(new URL('..', import.meta.url))

/** 头部允许的字段。多了别的，有的 harness 会拒收或报警告 */
const ALLOWED_KEYS = ['name', 'description']
/** name 的格式：小写字母、数字和单个连字符，不超过 64 个字（Claude、Codex 的规矩） */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
const NAME_MAX = 64
/** description 的上限（Claude、Codex、Pi 都是 1024） */
const DESCRIPTION_MAX = 1024
/** SKILL.md 正文的行数上限（Claude 的建议：长了拆到 references 里） */
const BODY_MAX_LINES = 500

/** 拆出头部的各项。不合规矩的地方记进 errors */
export function parseFrontmatter(text, errors) {
  const lines = text.split('\n')
  if (lines[0] !== '---') {
    errors.push('SKILL.md 第一行必须是 ---')
    return { fields: {}, body: text }
  }
  const end = lines.indexOf('---', 1)
  if (end < 0) {
    errors.push('SKILL.md 的头部没有收尾的 ---')
    return { fields: {}, body: text }
  }
  const fields = {}
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_-]+):\s?(.*)$/.exec(line)
    if (!match) {
      errors.push(`SKILL.md 头部这一行读不懂（每项写在一行里）：${line}`)
      continue
    }
    const [, key, raw] = match
    let value = raw.trim()
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value)
      } catch {
        errors.push(`SKILL.md 头部 ${key} 的双引号没配对或转义不对`)
        continue
      }
    } else if (value.startsWith("'") || value === '' || value === '|' || value === '>') {
      errors.push(`SKILL.md 头部 ${key} 要写成一行，用双引号或不加引号`)
      continue
    }
    if (key in fields) errors.push(`SKILL.md 头部 ${key} 写了两次`)
    fields[key] = value
  }
  return { fields, body: lines.slice(end + 1).join('\n') }
}

function checkFrontmatter(dir, errors) {
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  const { fields, body } = parseFrontmatter(text, errors)
  for (const key of Object.keys(fields)) {
    if (!ALLOWED_KEYS.includes(key))
      errors.push(`SKILL.md 头部多了 ${key}（只许 ${ALLOWED_KEYS.join('、')}）`)
  }
  const name = fields.name
  const folder = dir.split(/[/\\]/).filter(Boolean).pop()
  if (typeof name !== 'string' || !NAME_PATTERN.test(name) || name.length > NAME_MAX) {
    errors.push(`SKILL.md 的 name 不合格式：${name}`)
  } else if (name !== 'litch-manual' || name !== folder) {
    errors.push(
      `SKILL.md 的 name 要是 litch-manual，并且和目录同名（现在 ${name}，目录 ${folder}）`,
    )
  }
  const description = fields.description
  if (typeof description !== 'string' || description.trim() === '') {
    errors.push('SKILL.md 没有 description')
  } else {
    const length = [...description].length
    if (length > DESCRIPTION_MAX) {
      errors.push(`SKILL.md 的 description 有 ${length} 个字，超过 ${DESCRIPTION_MAX}`)
    }
    if (/[<>]/.test(description)) errors.push('SKILL.md 的 description 里不许有尖括号')
    if (!/[一-鿿]/.test(description) || !/[A-Za-z]{4,}/.test(description)) {
      errors.push('SKILL.md 的 description 要中英文都有')
    }
  }
  const bodyLines = body.split('\n').length
  if (bodyLines > BODY_MAX_LINES) {
    errors.push(`SKILL.md 正文 ${bodyLines} 行，超过 ${BODY_MAX_LINES}：拆到 references 里`)
  }
  return text
}

/** 手册里所有的 markdown：SKILL.md 和 references 下的 */
function manualFiles(dir) {
  const references = join(dir, 'references')
  return [
    join(dir, 'SKILL.md'),
    ...readdirSync(references)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => join(references, name)),
  ]
}

/** 一个词像不像操作名（不是占位的 <组>、省略号、参数） */
const word = (token) => typeof token === 'string' && /^[a-z][a-z-]*$/.test(token)

/**
 * 手册里写成 `scripts/litch 组 动作` 的地方，逐个核对组和动作都存在；同时记下提到过哪些操作。
 * 只认同一行里、紧跟在命令后面的两个词
 */
export function checkMentions(files, ops, errors) {
  const groups = new Map()
  for (const op of ops) {
    if (!groups.has(op.group)) groups.set(op.group, new Set())
    if (op.action) groups.get(op.group).add(op.action)
  }
  const mentioned = new Set()
  const pattern = /scripts[/\\]litch(?:\.cmd)?[ \t]+([^\s`|]+)(?:[ \t]+([^\s`|]+))?/g
  for (const { path, text } of files) {
    text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        const [, group, action] = match
        if (!word(group)) continue
        const where = `${path}:${index + 1}`
        const actions = groups.get(group)
        if (!actions) {
          errors.push(`${where} 提到了不存在的组：scripts/litch ${group}`)
          continue
        }
        if (actions.size === 0) {
          mentioned.add(group)
          continue
        }
        if (!word(action)) continue
        if (!actions.has(action)) {
          errors.push(`${where} 提到了不存在的操作：scripts/litch ${group} ${action}`)
          continue
        }
        mentioned.add(`${group} ${action}`)
      }
    })
  }
  for (const op of ops) {
    const name = configOpName(op)
    if (!mentioned.has(name)) errors.push(`手册里没讲到操作 scripts/litch ${name}`)
  }
}

function checkReferences(dir, skill, errors) {
  const listed = new Set([...skill.matchAll(/references\/([a-z0-9-]+\.md)/g)].map((m) => m[1]))
  const present = new Set(
    readdirSync(join(dir, 'references')).filter((name) => name.endsWith('.md')),
  )
  for (const name of listed) {
    if (!present.has(name)) errors.push(`SKILL.md 提到的 references/${name} 不存在`)
  }
  for (const name of present) {
    if (!listed.has(name)) errors.push(`references/${name} 没有在 SKILL.md 里提到，模型找不到它`)
  }
}

function checkScripts(dir, errors) {
  const shell = join(dir, 'scripts', 'litch')
  const sh = readFileSync(shell, 'utf8')
  if (!sh.startsWith('#!/bin/sh\n')) errors.push('scripts/litch 第一行要是 #!/bin/sh')
  if (!sh.includes('exec "{{ADAPTER}}" config "$@"')) {
    errors.push('scripts/litch 里要有 exec "{{ADAPTER}}" config "$@"（安装时替换路径）')
  }
  if (process.platform !== 'win32' && (statSync(shell).mode & 0o111) === 0) {
    errors.push('scripts/litch 不可执行')
  }
  const cmd = readFileSync(join(dir, 'scripts', 'litch.cmd'), 'utf8')
  if (!cmd.includes('"{{ADAPTER}}" config %*')) {
    errors.push('scripts/litch.cmd 里要有 "{{ADAPTER}}" config %*')
  }
  if (cmd.replace(/\r\n/g, '').includes('\n')) errors.push('scripts/litch.cmd 要用 CRLF 换行')
}

/** 公开的手册里不该有的东西 */
const PRIVATE = [
  [/决\s*\d{3}/, '内部决策编号'],
  [/\/Volumes\//, '本机路径'],
  [/design\/harness-client/, '工作区的设计文档路径'],
]

/** versions.json 里各 harness 的验证版：手册的安装表里要原样写着 */
function checkVersions(dir, errors) {
  const versions = JSON.parse(readFileSync(join(repo, 'protocol', 'versions.json'), 'utf8'))
  const text = readFileSync(join(dir, 'references', 'harnesses.md'), 'utf8')
  const wanted = {
    'Claude Code': versions.claudeCli,
    Codex: versions.codexVerified?.[0],
    Pi: versions.piCli,
    DSH: versions.dshVerified?.[0],
    OpenCode: versions.opencodeVerified?.[0],
  }
  for (const [name, version] of Object.entries(wanted)) {
    if (!version) continue
    const row = text.split('\n').find((line) => line.startsWith(`| ${name} |`))
    if (!row) errors.push(`references/harnesses.md 的安装表里没有 ${name} 这一行`)
    else if (!row.includes(`| ${version} |`)) {
      errors.push(
        `references/harnesses.md 里 ${name} 的验证版应为 ${version}（protocol/versions.json）`,
      )
    }
  }
}

export function checkManual(dir) {
  const errors = []
  const skill = checkFrontmatter(dir, errors)
  const files = manualFiles(dir).map((path) => ({
    path: relative(dir, path),
    text: readFileSync(path, 'utf8'),
  }))
  checkMentions(files, CONFIG_OPS, errors)
  checkReferences(dir, skill, errors)
  checkScripts(dir, errors)
  checkVersions(dir, errors)
  for (const { path, text } of files) {
    for (const [pattern, what] of PRIVATE) {
      if (pattern.test(text)) errors.push(`${path} 里有${what}：手册会装到用户机器上，不要写`)
    }
  }
  return errors
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? join(repo, 'skills', 'litch-manual')
  const errors = checkManual(dir)
  if (errors.length > 0) {
    console.error(`产品手册有 ${errors.length} 处不对：`)
    for (const error of errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log(`产品手册检查通过（${CONFIG_OPS.length} 个操作都讲到了）`)
}
