import {
  type GithubApi,
  GithubFault,
  type GithubRepository,
  githubId,
  githubLogin,
  githubObject,
  githubRepoPath,
  verifyGithubRepository,
} from './read-api.mjs'

export interface GithubActorEvidence {
  userId: string
  login: string
}

export function githubActor(raw: unknown): GithubActorEvidence | undefined {
  const actor = githubObject(raw)
  const userId = githubId(actor.id)
  const login = githubLogin(actor.login)
  return userId && login ? { userId, login } : undefined
}

export async function verifyGithubBot(
  api: GithubApi,
  expectedId: string,
): Promise<GithubActorEvidence> {
  const actor = githubActor((await api.get('/user')).body)
  if (!actor || actor.userId !== expectedId) throw new GithubFault('authentication')
  return actor
}

export type GithubIdentity = 'robot' | 'owner' | 'other'

export function githubIdentity(
  actor: GithubActorEvidence,
  botId: string,
  ownerId?: string,
): GithubIdentity {
  if (actor.userId === botId) return 'robot'
  if (ownerId !== undefined && actor.userId === ownerId) return 'owner'
  return 'other'
}

export type GithubRoleEvidence =
  | { state: 'verified'; eligible: boolean; roleName: string; checkedAt: number }
  | { state: 'identity-mismatch' }
  | { state: 'unavailable'; reason: GithubFault['kind']; retryAt?: number }

export async function lookupGithubRole(
  api: GithubApi,
  repo: GithubRepository,
  actor: GithubActorEvidence,
  verifiedCustomRoles: readonly string[] = [],
): Promise<GithubRoleEvidence> {
  if (!githubId(actor.userId) || !githubLogin(actor.login)) return { state: 'identity-mismatch' }
  try {
    await verifyGithubRepository(api, repo)
    const response = await api.get(
      `${githubRepoPath(repo)}/collaborators/${encodeURIComponent(actor.login)}/permission`,
    )
    const object = githubObject(response.body)
    if (githubId(githubObject(object.user).id) !== actor.userId)
      return { state: 'identity-mismatch' }
    const { permission, role_name: roleName } = object
    if (
      typeof roleName !== 'string' ||
      !roleName ||
      roleName.length > 128 ||
      !['none', 'read', 'triage', 'write', 'maintain', 'admin'].includes(String(permission))
    ) {
      throw new GithubFault('invalid-response')
    }
    const eligible =
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write' ||
      permission === 'triage' ||
      (permission === 'read' &&
        (roleName === 'triage' ||
          (!['read', 'none', 'write', 'maintain', 'admin'].includes(roleName) &&
            verifiedCustomRoles.includes(roleName))))
    return { state: 'verified', eligible, roleName, checkedAt: response.serverTime }
  } catch (error) {
    if (!(error instanceof GithubFault)) throw error
    return {
      state: 'unavailable',
      reason: error.kind,
      ...(error.retryAt !== undefined ? { retryAt: error.retryAt } : {}),
    }
  }
}

// REST 的正文没有结构化提及。无法确定仍在引用或 HTML 区域时，保守排除。
function prose(body: string): string {
  let fence: string | undefined
  let quote = false
  let hidden: string | undefined
  const lines: string[] = []
  for (const raw of body.split(/\r?\n/)) {
    let line = raw
    if (hidden) {
      const end = line.toLowerCase().indexOf(hidden)
      if (end === -1) continue
      line = line.slice(end + hidden.length)
      hidden = undefined
    }
    const markdownLine = line.replace(/^(?: {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)+/, '')
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(markdownLine)?.[1]
    if (fence) {
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        markdownLine.trim() === marker
      )
        fence = undefined
      continue
    }
    if (/^ {0,3}>/.test(markdownLine)) {
      quote = true
      continue
    }
    if (quote && line.trim()) continue
    quote = false
    if (
      marker &&
      (marker[0] === '~' || !markdownLine.trimStart().slice(marker.length).includes('`'))
    ) {
      fence = marker
      continue
    }
    if (/^(?: {4}| {0,3}\t)/.test(markdownLine)) continue
    // 先剔除隐藏块，保留同一行其余正文。
    line = line.replace(/<!--[\s\S]*?-->|<(pre|code|blockquote)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    const begin = /<!--|<(pre|code|blockquote)\b[^>]*>/i.exec(line)
    if (begin) {
      hidden = begin[1] ? `</${begin[1].toLowerCase()}>` : '-->'
      line = line.slice(0, begin.index)
    }
    lines.push(line)
  }
  return lines.join('\n')
}

function removeCodeSpans(input: string): string {
  // 反引号串必须同长。索引下一串可避免异常正文造成反复扫描。
  const reverse = [...input.matchAll(/`+/g)].reverse()
  const next = new Map<number, number>()
  const positions = new Map<number, number>()
  for (const run of reverse) {
    const pos = positions.get(run[0].length)
    if (pos !== undefined) next.set(run.index, pos)
    positions.set(run[0].length, run.index)
  }
  let offset = 0
  let result = ''
  for (const run of reverse.reverse()) {
    if (run.index < offset) continue
    const close = next.get(run.index)
    if (close !== undefined) {
      result += `${input.slice(offset, run.index)} `
      offset = close + run[0].length
    }
  }
  return result + input.slice(offset)
}

export function mentionsGithubLogin(body: string, login: string): boolean {
  if (!githubLogin(login)) return false
  const content = removeCodeSpans(prose(body))
    .replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*/gm, ' ')
    .replace(/\]\((?:[^()\s]|\([^()\s]*\))*?(?:\s+["'][^"'\n]*["'])?\)/g, '] ')
    .replace(/\]\([^\n]*/g, '] ')
    .replace(/\]\[[^\]\n]*\]/g, '] ')
    .replace(
      /<[^>\n]*>|(?:\b[a-z][a-z\d+.-]*:\/\/|\b(?:mailto|data|tel|ssh|git|urn):|\bwww\.|\b(?:[a-z\d-]+\.)+[a-z]{2,}\/)[^\s<>"'\u0060]+/gi,
      ' ',
    )
  const who = login.toLowerCase()
  for (const match of content.matchAll(
    /(^|[^\p{L}\p{N}_@/\\-])@([a-z\d]+(?:-[a-z\d]+)*(?:\[bot\])?)(?![\p{L}\p{N}_/-])/giu,
  )) {
    if (match[2]?.toLowerCase() === who) return true
  }
  return false
}
