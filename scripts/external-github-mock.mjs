// 每类返回只接受夹具身份。GitHub 正文、账号和令牌全部合成。
import {
  bot,
  githubMock,
  owner,
  repoMetadata,
  repoPath,
  respond,
  subject,
} from '../packages/device/dist/packages/device/test/fixtures/external-d.mjs'

export { bot, owner, repoPath, subject }
export const oauth = 'gho_fixture0123456789abcdefghijklmnopqrstuvwxyz'
export const repo = { ...repoMetadata, permissions: { push: true, triage: true }, has_issues: true }
export const web = 'https://github.com/example/demo'
export const api = `https://api.github.com${repoPath}`
const outsider = { id: '701', login: 'outsider' }
const account = { id: bot, type: 'User', login: 'litch-device' }
const ownerAccount = { id: owner, login: 'owner', type: 'User' }

export async function scenario(t, clock) {
  const issues = new Map()
  const pulls = new Map()
  const sent = new Map()
  const states = { created: 0, updated: 0, opened: 0, disconnectWrite: true, run: null }
  const stamp = () => new Date(clock.now * 1000).toISOString()
  const openPull = (number) => {
    const pull = {
      id: String(number + 2000),
      number,
      state: 'open',
      title: 'Fixture draft',
      draft: true,
      user: account,
      body: 'Synthetic PR from the injected workline',
      created_at: stamp(),
      updated_at: stamp(),
      url: `${api}/pulls/${number}`,
      html_url: `${web}/pull/${number}`,
      labels: [],
      assignees: [],
      head: { ref: 'litch/fixture', sha: 'a'.repeat(40), repo: { id: repo.id } },
      base: { ref: 'main', repo: { id: repo.id } },
    }
    pulls.set(String(number), pull)
    return pull
  }
  const mock = await githubMock(t, (req, res, url, data) => {
    const p = url.pathname
    res.setHeader('date', new Date(clock.now * 1000).toUTCString())
    if (p === `/user/${owner}` || p === '/users/owner') respond(res, ownerAccount)
    else if (p === '/user' && req.headers.authorization === `Bearer ${oauth}`) {
      res.setHeader('X-OAuth-Scopes', 'repo, read:org, gist')
      respond(res, account)
    } else if (p === '/user/repos') respond(res, [repo])
    else if (p === '/users/outsider') respond(res, outsider)
    else if (p === `${repoPath}/collaborators/outsider/permission`)
      respond(res, { permission: 'read', role_name: 'read', user: outsider })
    else if (p === repoPath) respond(res, repo)
    else if (p === `${repoPath}/issues`)
      respond(res, [
        ...issues.values(),
        ...[...pulls.values()].map((pull) => ({
          ...pull,
          html_url: `${web}/pull/${pull.number}`,
          pull_request: { url: `${api}/pulls/${pull.number}` },
        })),
      ])
    else if (p === `${repoPath}/pulls`) {
      if (req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${oauth}`) respond(res, {}, 403)
        else {
          states.opened++
          respond(res, openPull(11), 201)
        }
      } else respond(res, [...pulls.values()])
    } else if (p === `${repoPath}/issues/events` || p === `${repoPath}/pulls/comments`)
      respond(res, [])
    else if (p === `${repoPath}/actions/runs`)
      respond(res, {
        total_count: states.run ? 1 : 0,
        workflow_runs: states.run ? [states.run] : [],
      })
    else if (p === `${repoPath}/actions/runs/77/attempts/1` || p === `${repoPath}/actions/runs/77`)
      respond(res, states.run ?? {}, states.run ? 200 : 404)
    else if (p === `${repoPath}/issues/comments`) respond(res, [...sent.values()])
    else if (p.startsWith(`${repoPath}/issues/comments/`)) {
      const id = p.split('/').at(-1)
      const before = sent.get(id)
      if (!before) respond(res, {}, 404)
      else if (req.method === 'PATCH') {
        states.updated++
        const after = { ...before, body: data.body, updated_at: stamp() }
        sent.set(id, after)
        respond(res, after)
      } else respond(res, before)
    } else if (p.startsWith(`${repoPath}/issues/`)) {
      const [num, tail] = p.slice(`${repoPath}/issues/`.length).split('/')
      const issue = issues.get(num)
      if (tail === 'comments') {
        if (req.method === 'POST') {
          states.created++
          const id = String(90 + states.created)
          const row = {
            id,
            user: account,
            body: data.body,
            issue_url: `${api}/issues/${num}`,
            created_at: stamp(),
            updated_at: stamp(),
          }
          sent.set(id, row)
          if (states.disconnectWrite) {
            states.disconnectWrite = false
            res.destroy()
          } else respond(res, row, 201)
        } else
          respond(
            res,
            [...sent.values()].filter(({ issue_url }) => issue_url.endsWith(`/${num}`)),
          )
      } else respond(res, issue ?? {}, issue ? 200 : 404)
    } else if (p.startsWith(`${repoPath}/pulls/`)) {
      const [num, tail] = p.slice(`${repoPath}/pulls/`.length).split('/')
      const pull = pulls.get(num)
      if (tail === 'reviews' || tail === 'requested_reviewers') respond(res, [])
      else respond(res, pull ?? {}, pull ? 200 : 404)
    } else respond(res, {}, 404)
    return true
  })
  return {
    ...mock,
    states,
    sent,
    request(number, user = 'owner') {
      issues.set(String(number), {
        id: String(number + 1000),
        number,
        state: 'open',
        title: 'Fixture request',
        user: user === 'owner' ? ownerAccount : outsider,
        body: '@litch-device please handle this fixture',
        created_at: stamp(),
        updated_at: stamp(),
        url: `${api}/issues/${number}`,
        html_url: `${web}/issues/${number}`,
        labels: [],
        assignees: [],
      })
    },
    completeRun(number) {
      states.run = {
        id: '77',
        run_attempt: 1,
        workflow_id: '81',
        status: 'completed',
        conclusion: 'success',
        head_sha: 'a'.repeat(40),
        head_branch: 'litch/fixture',
        updated_at: stamp(),
        created_at: stamp(),
        repository: { id: repo.id },
        head_repository: { id: repo.id },
        html_url: `${web}/actions/runs/77`,
        pull_requests: [
          {
            number,
            head: { sha: 'a'.repeat(40), repo: { id: repo.id } },
            base: { repo: { id: repo.id } },
          },
        ],
      }
    },
  }
}
