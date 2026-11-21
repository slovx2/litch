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
  const comments = new Map()
  const sent = new Map()
  const notices = new Map()
  const timelines = new Map()
  const notificationRequests = []
  let notificationScope = false
  let notificationLimit = false
  let notificationDenied = false
  let history = 0
  let discovery = true
  const states = {
    created: 0,
    updated: 0,
    reactions: 0,
    opened: 0,
    disconnectWrite: true,
    run: null,
  }
  const stamp = () => new Date(clock.now * 1000).toISOString()
  const notify = (number, reason, detail = null) => {
    const pull = pulls.has(String(number))
    notices.set(number, {
      id: String(number),
      reason,
      unread: false,
      updated_at: stamp(),
      repository: { id: repo.id },
      subject: {
        type: pull ? 'PullRequest' : 'Issue',
        url: `${api}/${pull ? 'pulls' : 'issues'}/${number}`,
        latest_comment_url: detail,
      },
    })
  }
  const touchSubject = (num) => {
    const parent = issues.get(num) ?? pulls.get(num)
    if (parent) parent.updated_at = stamp()
  }
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
      res.setHeader(
        'X-OAuth-Scopes',
        `repo, read:org, gist${notificationScope ? ', notifications' : ''}`,
      )
      respond(res, account)
    } else if (p === '/user/repos') respond(res, [repo])
    else if (p === '/users/outsider') respond(res, outsider)
    else if (p === `${repoPath}/collaborators/outsider/permission`)
      respond(res, { permission: 'read', role_name: 'read', user: outsider })
    else if (p === `${repoPath}/notifications`) {
      notificationRequests.push({
        method: req.method,
        since: url.searchParams.get('since'),
        all: url.searchParams.get('all'),
      })
      if (!notificationScope || req.method !== 'GET') respond(res, {}, 403)
      else if (notificationLimit) {
        res.setHeader('X-RateLimit-Remaining', '0')
        res.setHeader('X-RateLimit-Reset', String(clock.now + 180))
        respond(res, {}, 403)
      } else if (notificationDenied) respond(res, {}, 403)
      else {
        const rows = [...notices.values()].filter(
          ({ updated_at }) =>
            Date.parse(updated_at) > Date.parse(url.searchParams.get('since') ?? ''),
        )
        res.setHeader('X-Poll-Interval', '60')
        respond(res, rows)
      }
    } else if (p === repoPath) respond(res, repo)
    else if (p === `${repoPath}/issues`)
      respond(res, [
        ...(discovery ? issues.values() : []),
        ...[...(discovery ? pulls.values() : [])].map((pull) => ({
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
    } else if (p === `${repoPath}/issues/events`) {
      const page = Number(url.searchParams.get('page') ?? 1)
      const next = new URL(url)
      next.searchParams.set('page', String(page + 1))
      if (page * 100 < history)
        res.setHeader('Link', `<https://api.github.com${next.pathname}${next.search}>; rel="next"`)
      const actions = [...(discovery ? timelines : [])].flatMap(([number, events]) =>
        events.map((event) => ({
          ...event,
          issue: issues.get(String(number)) ?? { ...pulls.get(String(number)), pull_request: {} },
        })),
      )
      const old = new Date((clock.now - 86_400) * 1000).toISOString()
      const rows = Array.from(
        { length: Math.min(100, Math.max(0, history - (page - 1) * 100)) },
        (_, i) => ({
          id: String(20000 + (page - 1) * 100 + i),
          event: 'mentioned',
          created_at: old,
        }),
      )
      respond(res, page === 1 ? [...actions, ...rows].slice(0, 100) : rows)
    } else if (p === `${repoPath}/pulls/comments`) respond(res, [])
    else if (p === `${repoPath}/actions/runs`)
      respond(res, {
        total_count: states.run ? 1 : 0,
        workflow_runs: states.run ? [states.run] : [],
      })
    else if (p === `${repoPath}/actions/runs/77/attempts/1` || p === `${repoPath}/actions/runs/77`)
      respond(res, states.run ?? {}, states.run ? 200 : 404)
    else if (p === `${repoPath}/issues/comments`)
      respond(res, [...comments.values(), ...sent.values()])
    else if (p.startsWith(`${repoPath}/issues/comments/`)) {
      const [id, tail] = p.slice(`${repoPath}/issues/comments/`.length).split('/')
      const before = comments.get(id) ?? sent.get(id)
      if (!before) respond(res, {}, 404)
      else if (tail === 'reactions' && req.method === 'POST') {
        states.reactions++
        before.updated_at = stamp()
        touchSubject(before.issue_url.split('/').at(-1))
        respond(res, { id: '501', content: data.content, user: account, created_at: stamp() }, 201)
      } else if (req.method === 'PATCH') {
        states.updated++
        const after = { ...before, body: data.body, updated_at: stamp() }
        sent.set(id, after)
        touchSubject(before.issue_url.split('/').at(-1))
        respond(res, after)
      } else respond(res, before)
    } else if (p.startsWith(`${repoPath}/issues/`)) {
      const [num, tail] = p.slice(`${repoPath}/issues/`.length).split('/')
      const issue = issues.get(num)
      if (tail === 'comments') {
        if (req.method === 'POST') {
          states.created++
          touchSubject(num)
          const id = String(90 + states.created)
          const row = {
            id,
            user: account,
            body: data.body,
            issue_url: `${api}/issues/${num}`,
            html_url: `${web}/${pulls.has(num) ? 'pull' : 'issues'}/${num}#issuecomment-${id}`,
            created_at: stamp(),
            updated_at: stamp(),
          }
          sent.set(id, row)
          notify(num, 'mention', `${api}/issues/comments/${id}`)
          if (states.disconnectWrite) {
            states.disconnectWrite = false
            res.destroy()
          } else respond(res, row, 201)
        } else
          respond(
            res,
            [...comments.values(), ...sent.values()].filter(({ issue_url }) =>
              issue_url.endsWith(`/${num}`),
            ),
          )
      } else if (tail === 'timeline') respond(res, timelines.get(num) ?? [])
      else {
        const pull = pulls.get(num)
        const row = issue ?? (pull ? { ...pull, pull_request: { url: pull.url } } : null)
        respond(res, row ?? {}, row ? 200 : 404)
      }
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
    notificationRequests,
    enableNotificationScope() {
      notificationScope = true
    },
    limitNotifications() {
      notificationLimit = true
    },
    denyNotifications() {
      notificationDenied = true
    },
    setHistory(rows) {
      history = rows
    },
    setDiscovery(visible) {
      discovery = visible
    },
    requestPull(number, isReviewRequest = false) {
      const pull = openPull(number)
      pull.user = ownerAccount
      pull.body = isReviewRequest
        ? 'Fixture review requested'
        : '@litch-device please review this fixture'
      pull.head.ref = 'feature/fixture'
      if (isReviewRequest) {
        pull.requested_reviewers = [account]
        timelines.set(String(number), [
          {
            id: String(number + 5000),
            event: 'review_requested',
            created_at: stamp(),
            actor: ownerAccount,
            review_requester: ownerAccount,
            requested_reviewer: account,
          },
        ])
      }
      notify(String(number), isReviewRequest ? 'review_requested' : 'mention')
      return pull
    },
    setSubjectState(number, state, merged = false) {
      const row = issues.get(String(number)) ?? pulls.get(String(number))
      if (!row) throw new Error('夹具主题不存在')
      row.state = state
      row.updated_at = stamp()
      row.closed_at = state === 'closed' ? stamp() : null
      if (pulls.has(String(number))) row.merged_at = merged ? stamp() : null
    },
    request(number, user = 'owner', body = '@litch-device please handle this fixture') {
      const issue = {
        id: String(number + 1000),
        number,
        state: 'open',
        title: 'Fixture request',
        user: user === 'owner' ? ownerAccount : outsider,
        body,
        created_at: stamp(),
        updated_at: stamp(),
        url: `${api}/issues/${number}`,
        html_url: `${web}/issues/${number}`,
        labels: [],
        assignees: [],
      }
      issues.set(String(number), issue)
      if (body.includes('@litch-device')) notify(String(number), 'mention')
      return issue
    },
    assign(number) {
      const row = this.request(number, 'owner', 'Fixture assigned')
      row.assignees = [account]
      timelines.set(String(number), [
        {
          id: String(number + 5000),
          event: 'assigned',
          created_at: stamp(),
          actor: account,
          assigner: ownerAccount,
          assignee: account,
        },
      ])
      notify(String(number), 'assign')
      return row
    },
    comment(number, id, body = '@litch-device please handle this comment') {
      const row = {
        id,
        user: ownerAccount,
        body,
        issue_url: `${api}/issues/${number}`,
        html_url: `${web}/issues/${number}#issuecomment-${id}`,
        created_at: stamp(),
        updated_at: stamp(),
      }
      comments.set(id, row)
      touchSubject(String(number))
      notify(String(number), 'mention', `${api}/issues/comments/${id}`)
      return row
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
