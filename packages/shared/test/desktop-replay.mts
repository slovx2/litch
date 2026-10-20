// 回放：把 protocol/compat/desktop-replay.json 里“官方桌面端会发的请求序列”对着一个入口发一遍。
// 每一步要么成功，要么是夹具里为这个入口登记的那个错误码（问没有的会话的那几步要答“这里没有”，见 Step.absent）；
// 应答的结构由客户端一路严格校验，出入交给基线。
// 一步挂住（到时限没有应答）整个回放就失败。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { protocolDirectory } from '../src/protocol-path.mjs'
import {
  type EntryScene,
  type SceneName,
  standardAnswer,
  type TurnScript,
} from './compat-scene.mjs'
import type { StandardClient } from './standard-client.mjs'
import { upstreamHasRequest } from './strict-schema.mjs'

interface Step {
  id?: string
  phase?: string
  method: string
  params?: unknown
  /** 这一回合要模型怎么演 */
  scene?: SceneName
  /** 把入口自己的建会话参数并进来 */
  threadStart?: boolean
  /** 从应答里取值记下来：名字 → 应答里的路径 */
  save?: Record<string, string>
  /** 应答之后再等的一条通知 */
  await?: string
  /** 要先有这些值才做得了；前面的步骤没成就跳过 */
  needs?: string[]
  /**
   * 问的是这个入口上没有的会话（桌面端找一个置顶会话在哪台机器上时，拿它的会话号向每个连着的入口都问一遍）。
   * 必须被拒绝，错误的话是上游的说法（ABSENT 后面接会话号）：桌面端按话术认“这里没有”，错误码它不看；
   * 认不出的话它把这个入口当成出了错的机器。这种步骤不进 expectations
   */
  absent?: boolean
}

/** 上游表示“没有这个会话”的说法（会话号接在后面），见 Step.absent */
const ABSENT = 'thread not found: '

interface Fixture {
  protocol: string
  client: { clientInfo: Record<string, unknown>; capabilities: Record<string, unknown> }
  steps: Step[]
  expectations: Record<string, Record<string, number> | string>
}

export const replayFixturePath = resolve(
  process.env.CODEX_SCHEMA_DIR ?? protocolDirectory(),
  '../../../compat/desktop-replay.json',
)

export interface ReplayReport {
  succeeded: string[]
  /** 被拒绝的步骤 → 错误码 */
  refused: Record<string, number>
  /** 前面的步骤没成、这个入口演不了，没法做的 */
  skipped: string[]
}

function fill(value: unknown, values: Record<string, unknown>): unknown {
  const need = (name: string): unknown => {
    if (!(name in values)) throw new Error(`回放夹具用了没有的值 {{${name}}}`)
    return values[name]
  }
  if (typeof value === 'string') {
    const whole = /^\{\{(?<name>\w+)\}\}$/.exec(value)?.groups?.name
    if (whole) return need(whole)
    return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(need(name)))
  }
  if (Array.isArray(value)) return value.map((entry) => fill(entry, values))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, fill(entry, values)]),
    )
  return value
}

// 在工作目录下面现建一个带远端的 git 仓库，工作区里留一处没提交的改动：gitDiffToRemote 要有东西可比。
function prepareRepository(root: string): string {
  const repo = join(root, 'replay-repo')
  const remote = join(root, 'replay-remote.git')
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync(
      'git',
      ['-c', 'user.name=replay', '-c', 'user.email=replay@example.invalid', ...args],
      {
        cwd,
        stdio: 'ignore',
        // 不读个人的 git 配置
        env: { PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
      },
    )
  }
  mkdirSync(repo)
  git(repo, 'init', '--initial-branch=main')
  writeFileSync(join(repo, 'notes.txt'), '第一版\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', '回放用的提交')
  git(root, 'clone', '--bare', repo, remote)
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'fetch', 'origin')
  writeFileSync(join(repo, 'notes.txt'), '第二版\n')
  return repo
}

const pick = (value: any, path: string): unknown =>
  path.split('.').reduce((current, key) => current?.[key], value)

export async function runDesktopReplay(
  client: StandardClient,
  scene: EntryScene,
): Promise<ReplayReport> {
  const fixture = JSON.parse(readFileSync(replayFixturePath, 'utf8')) as Fixture
  const expected = fixture.expectations[scene.entry]
  if (!expected || typeof expected !== 'object')
    throw new Error(`回放夹具的 expectations 里没有 ${scene.entry}`)
  const values: Record<string, unknown> = {
    cwd: scene.cwd,
    dir: join(scene.cwd, 'replay-dir'),
    file: join(scene.cwd, 'replay-notes.txt'),
    copy: join(scene.cwd, 'replay-notes-copy.txt'),
    repo: prepareRepository(scene.cwd),
  }
  const report: ReplayReport = { succeeded: [], refused: {}, skipped: [] }
  const wrong: string[] = []
  const seen = new Set<string>()
  // 最近一个排了模型应答的回合：它结束之后放掉还压着的应答
  let pending: TurnScript | null = null

  await client.handshake(fixture.client.clientInfo, fixture.client.capabilities)
  client.onServerRequest = (method, params) => standardAnswer(method, params)

  for (const step of fixture.steps) {
    const id = step.id ?? step.method
    if (seen.has(id)) throw new Error(`回放夹具里步骤 ${id} 重名了，给它一个 id`)
    seen.add(id)
    if (!upstreamHasRequest(step.method) && fixture.protocol && !(id in expected))
      throw new Error(
        `回放夹具的 ${id}：${fixture.protocol} 的上游协议里没有这个方法，要在 expectations 里写明每个入口怎么拒绝它`,
      )
    if (step.needs?.some((name) => !(name in values))) {
      report.skipped.push(id)
      continue
    }
    let script: TurnScript | null = null
    if (step.scene) {
      script = await scene.script(step.scene)
      if (!script) {
        report.skipped.push(id)
        continue
      }
      values.prompt = script.prompt
    }
    const params =
      step.params === undefined
        ? undefined
        : {
            ...(fill(step.params, values) as Record<string, unknown>),
            ...(step.threadStart ? scene.threadStart : {}),
            ...script?.params,
          }
    const reply = await client.request(step.method, params)
    const code = expected[id]
    if (step.absent) {
      const threadId = (params as { threadId?: unknown } | undefined)?.threadId
      if (code !== undefined) wrong.push(`${id} 问的是没有的会话，不该写进 expectations`)
      if (!reply.error) wrong.push(`${id} 问的是没有的会话，却成功了`)
      else {
        report.refused[id] = reply.error.code
        if (reply.error.message !== `${ABSENT}${threadId}`)
          wrong.push(
            `${id} 的错误要说“${ABSENT}${threadId}”（桌面端按这句认“这里没有”），实际是 ${reply.error.code}：${reply.error.message}`,
          )
      }
      continue
    }
    if (reply.error) {
      script?.release?.()
      report.refused[id] = reply.error.code
      if (code === undefined)
        wrong.push(`${id} 应当成功，却被拒绝：${JSON.stringify(reply.error).slice(0, 300)}`)
      else if (code !== reply.error.code)
        wrong.push(
          `${id} 的错误码应当是 ${code}，实际是 ${reply.error.code}（${reply.error.message}）`,
        )
      continue
    }
    report.succeeded.push(id)
    if (code !== undefined)
      wrong.push(`${id} 现在成功了：把它从回放夹具 expectations.${scene.entry} 里删掉`)
    for (const [name, path] of Object.entries(step.save ?? {})) {
      const value = pick(reply.result, path)
      if (value === undefined) wrong.push(`${id} 的应答里没有 ${path}`)
      else values[name] = value
    }
    if (script) pending = script
    if (step.await === 'turn/completed' || step.await === 'turn/started')
      await client.until(
        step.await,
        (sent) => sent.turn?.id === values.turnId,
        `${id} 之后的 ${step.await}`,
      )
    else if (step.await) await client.until(step.await, () => true, `${id} 之后的 ${step.await}`)
    // 要打断的回合：话是流出来的就等头一段到了再往下走
    if (step.await === 'turn/started' && script?.streams)
      await client.until(
        'item/agentMessage/delta',
        (sent) => sent.turnId === values.turnId,
        `${id} 之后的头一段话`,
      )
    if (step.await === 'turn/completed') pending?.release?.()
  }

  // 官方桌面端按 clientId 认出自己先显示出来的那条用户消息（和上游一样，用户消息作为条目发回来）：
  // 带了 clientUserMessageId 的回合，这条用户消息的开始、完成各来一次、是同一个条目，带着那个标识。
  // 多出一个条目号，桌面端就显示两条
  for (const step of fixture.steps) {
    const clientId = (step.params as { clientUserMessageId?: unknown } | undefined)
      ?.clientUserMessageId
    const id = step.id ?? step.method
    if (step.method !== 'turn/start' || typeof clientId !== 'string') continue
    if (!report.succeeded.includes(id)) continue
    const echoed = client.received.filter(
      (message) =>
        (message.method === 'item/started' || message.method === 'item/completed') &&
        message.params?.item?.type === 'userMessage' &&
        message.params.item.clientId === clientId,
    )
    const methods = echoed.map((message) => message.method).join('、')
    const items = new Set(echoed.map((message) => message.params.item.id))
    if (methods !== 'item/started、item/completed' || items.size !== 1)
      wrong.push(
        `${id} 的用户消息应当带着 clientId 发回来，开始、完成各一次、同一个条目，实际是：${methods || '没有'}（${items.size} 个条目）`,
      )
  }

  // 握手时退订了的通知，上游是不发的
  const optedOut = new Set(fixture.client.capabilities.optOutNotificationMethods as string[])
  for (const message of client.received)
    if (typeof message.method === 'string' && !('id' in message) && optedOut.has(message.method))
      client.note(
        {
          kind: 'notification',
          method: message.method,
          path: '',
          problem: '握手时退订了，仍然发来',
        },
        message,
      )
  for (const id of Object.keys(expected))
    if (!seen.has(id)) wrong.push(`回放夹具 expectations.${scene.entry} 里的 ${id} 不是任何一步`)
  if (wrong.length) throw new Error(`${scene.entry} 的回放与预期不符：\n  ${wrong.join('\n  ')}`)
  return report
}
