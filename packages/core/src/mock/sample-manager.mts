// 经理原型的五位经理与主看板。第一版没有到期执行，D-11 用已答结果表达。
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
} from '../../../protocol/src/manager.mjs'
import type { SessionView } from '../model.mjs'
import type { ManagerBoardView, ManagerDecisionView, ManagerView } from '../model-manager.mjs'
import type { SampleLang } from './sample-text.mjs'

export type { ManagerSessionSummary } from '../projection/manager.mjs'

import type { ManagerSessionSummary } from '../projection/manager.mjs'

/** 示例经理有自己的开场，不走普通会话按 id 生成占位消息的分支。 */
export function sampleManagerHistory(
  manager: ManagerView,
  board: ManagerBoardView,
  lang: SampleLang,
): Pick<SessionView, 'turns' | 'items'> {
  const zh = lang === 'zh-CN'
  const turnId = `${manager.id}-opening`
  const userId = `${turnId}-user`
  const answerId = `${turnId}-answer`
  const pending = board.decisions.filter((decision) => decision.status === 'open').length
  const opening = zh
    ? `请负责「${manager.name}」。范围：${manager.scope}。请安排工作线、核对回报，需要我决定的事情放到看板。`
    : `Please manage “${manager.name}”. Scope: ${manager.scope}. Organize the work lines, verify their reports, and put decisions that need my input on the board.`
  const progress =
    board.situation?.text ??
    (manager.status === 'ending'
      ? zh
        ? '正在整理总结，未完成事项和决策会保留在看板上。'
        : 'I am preparing the summary. Unfinished items and decisions will remain on the board.'
      : manager.status === 'ended'
        ? zh
          ? '本轮工作已结束，未完成事项和决策保留在看板上。'
          : 'This round has ended. Unfinished items and decisions remain on the board.'
        : zh
          ? '我会先按范围梳理事项和验收条件，列出计划，等待你确认开始。'
          : 'I will outline the items and acceptance criteria, present a plan, and wait for you to start.')
  const answer = pending
    ? `${progress}\n\n${zh ? `看板上有 ${pending} 项决策需要你确认，背景与选项已列出。` : `There are ${pending} decisions for you on the board, with their background and options.`}`
    : progress
  return {
    turns: [
      {
        id: turnId,
        status: 'completed',
        itemIds: [userId, answerId],
        startedAt: manager.updatedAt - 60_000,
        durationMs: 32_000,
        error: null,
      },
    ],
    items: {
      [userId]: { id: userId, kind: 'userMessage', text: opening, attachments: [] },
      [answerId]: {
        id: answerId,
        kind: 'agentMessage',
        phase: 'final',
        status: 'completed',
        text: answer,
      },
    },
  }
}

export function sampleManagers(
  deviceId: string,
  now: number,
  lang: SampleLang,
): {
  managers: ManagerView[]
  boards: ManagerBoardView[]
  sessions: ManagerSessionSummary[]
} {
  const t = (zh: string, en: string) => (lang === 'zh-CN' ? zh : en)
  const ago = (minutes: number) => now - minutes * 60_000
  const cwd = deviceId === 'build' ? '/srv/work/infra' : '~/work/litch'
  const managers: ManagerView[] = []
  const boards: ManagerBoardView[] = []
  const sessions: ManagerSessionSummary[] = []
  const definitions = [
    [
      'm1',
      'local',
      'Litch 0.23',
      t(
        '回退改成编辑原消息（桌面和手机），补验子会话归档和 Windows，做完发版',
        'Edit original messages to rewind on desktop and mobile; verify child archiving and Windows, then release',
      ),
    ],
    [
      'm2',
      'build',
      t('sub2api 网关稳定性', 'sub2api gateway stability'),
      t(
        '查清 522 的来源，加监控，观察一周',
        'Find the source of 522 errors, add monitoring, and observe for a week',
      ),
    ],
    [
      'm3',
      'local',
      t('移动端体验打磨', 'Mobile experience'),
      t('列表滚动、输入框高度、深色表格三件事', 'List scrolling, composer height, and dark tables'),
    ],
    ['e1', 'local', 'Litch 0.22', t('留下 2 项决策、3 件事', '2 decisions and 3 items remain')],
    ['e2', 'local', 'Litch 0.21', t('全部关闭', 'Everything closed')],
  ]
  const children = [
    [
      'manager-k1',
      'm1',
      t('回退改成编辑原消息', 'Edit original messages to rewind'),
      'claude',
      true,
    ],
    [
      'manager-k2',
      'm1',
      t('子会话能归档（照 Claude）', 'Archive child sessions like Claude'),
      'claude',
      false,
    ],
    [
      'manager-k3',
      'm1',
      t('后台任务页筛选：先调研', 'Research background task filters'),
      'pi',
      true,
    ],
    [
      'manager-k4',
      'm1',
      t('恢复 CLI 重试并显示次数', 'Restore CLI retries and show attempts'),
      'claude',
      false,
    ],
    [
      'manager-k5',
      'm2',
      t('复现 522：压测网关', 'Reproduce 522 with gateway load tests'),
      'claude',
      true,
    ],
    ['manager-k6', 'm2', t('给上游加超时告警', 'Add upstream timeout alerts'), 'dsh', false],
    [
      'manager-k7',
      'm3',
      t('输入区高度不齐（复发）', 'Composer height mismatch returns'),
      'claude',
      false,
    ],
  ] as const
  function session(
    id: string,
    title: string,
    harness: string,
    managerId: string,
    parentId: string | null,
    running: boolean,
  ): ManagerSessionSummary {
    return {
      id,
      title,
      harness,
      cwd,
      workspaceId: deviceId === 'build' ? 'infra' : 'litch',
      status: running ? 'running' : 'idle',
      waitingFor: null,
      unread: id === 'manager-k2',
      updatedAt: ago(12),
      pinned: false,
      section: null,
      placedAt: null,
      task: null,
      queuedNotes: [],
      nativeLineage: null,
      background: null,
      worktree: null,
      litchManager: { managerId, role: parentId ? 'line' : 'manager' },
      lineage: parentId
        ? {
            parentId,
            kind: 'fresh',
            origin: 'model',
            title,
            wakeParent: true,
            reportParent: true,
            createdAt: ago(120),
            proposalId: null,
          }
        : null,
    }
  }
  for (const [id, device, name, scope] of definitions) {
    if (device !== deviceId || !id || !name || !scope) continue
    const ended = id.startsWith('e')
    const manager: ManagerView = {
      id,
      deviceId,
      threadId: id,
      name,
      scope,
      cwd,
      harness: 'claude',
      model: null,
      effort: null,
      template: 'release',
      dispatch: { ...MANAGER_DEFAULT_DISPATCH },
      contact: { ...MANAGER_DEFAULT_CONTACT },
      rules: t(
        '分派工作、核对回报；需要用户决定的事项记入看板。',
        'Delegate work, verify reports, and record decisions for the user on the board.',
      ),
      status: ended ? 'ended' : 'active',
      pendingDecisions: 0,
      runningLines: 0,
      latestActivity: null,
      createdAt: ago(7200),
      updatedAt: ago(12),
      endedAt: ended ? ago(id === 'e1' ? 5760 : 7200) : null,
    }
    const board: ManagerBoardView = {
      deviceId,
      managerId: id,
      situation: null,
      decisions: [],
      items: [],
      lines: [],
      activities: [],
      changes: [],
    }
    managers.push(manager)
    boards.push(board)
    sessions.push(session(id, name, 'claude', id, null, id === 'm2'))
    for (const [kid, parent, title, harness, running] of children) {
      if (parent !== id) continue
      sessions.push(session(kid, title, harness, id, id, running))
      board.lines.push({
        threadId: kid,
        parentThreadId: id,
        title,
        harness,
        cwd,
        status: running ? 'running' : 'idle',
        running,
        startedAt: ago(kid === 'manager-k3' ? 4 : 12),
        elapsedSeconds: kid === 'manager-k3' ? 240 : 720,
        branch: null,
        ahead: null,
        merged: null,
        worktreeExists: null,
        report: null,
        unverified: [],
      })
    }
    manager.runningLines = board.lines.filter((line) => line.running).length
  }
  const main = boards.find((board) => board.managerId === 'm1')
  const decision = (
    id: ManagerDecisionView['id'],
    title: string,
    background = '',
    options: string[] = [],
  ): ManagerDecisionView => ({
    id,
    title,
    background,
    options: options.map((label, i) => ({
      id: String.fromCharCode(97 + i),
      label,
      description: '',
    })),
    recommend: options.length ? 'a' : null,
    default: { kind: 'ask' },
    blocks: [],
    links: [],
    basis: [],
    landed: [],
    revision: 1,
    status: 'open',
    checked: { commit: 'a9a85c1', at: ago(40) },
    answer: null,
    closed: null,
    createdAt: ago(180),
    updatedAt: ago(40),
  })
  if (main) {
    main.situation = {
      text: t(
        '回退编辑和后台任务筛选仍在进行；子会话归档等验收，CLI 重试已合入。发版前还有插话编辑和 Windows 补验需要决定。',
        'Rewind editing and background task filters are in progress. Child archiving awaits verification; CLI retries are merged. Steering-message editing and Windows verification still need decisions before release.',
      ),
      at: ago(18),
    }
    main.decisions = [
      decision(
        'D-15',
        t(
          '回退改成编辑原消息后，插话消息怎么办',
          'How should steering messages be edited when rewinding?',
        ),
        t(
          '0.20.0 定了回退改成“在原消息上编辑、确认才生效”。插话消息（回合进行中插进去的那条）在 Claude 上能单独回退，Codex 和 Pi 上不行。桌面和手机两条线都做到一半，要知道不支持的 harness 上插话消息露不露“编辑”。',
          'Version 0.20.0 chose editing the original message, applied only after confirmation. Claude can rewind a steering message separately; Codex and Pi cannot. Desktop and mobile implementations need a decision on showing Edit for unsupported harnesses.',
        ),
        [
          t(
            '不支持的 harness 上，插话消息不露“编辑”',
            'Hide Edit on steering messages for unsupported harnesses',
          ),
          t(
            '照样露出，但编辑等于回到这一回合开头，确认框里写清楚',
            'Show Edit, rewind to the turn start, and explain in confirmation',
          ),
          t(
            '插话消息一律不露，只在回合开头那条上露',
            'Only show Edit on the first message of a turn',
          ),
        ],
      ),
      decision(
        'D-16',
        t(
          '发 0.23.0 前要不要在 Windows 真机补验',
          'Verify on a Windows machine before releasing 0.23.0?',
        ),
        t(
          '0.20–0.22 的新功能都没在 Windows 上跑过：插话回退、子会话归档、重试次数。song-pc 现在空着，补验大约两小时，期间那台机器不能干别的。',
          'Features from 0.20–0.22 have not run on Windows: steering rewind, child archiving, and retry counts. song-pc is available; verification takes about two hours and occupies the machine.',
        ),
        [
          t('补验完再发', 'Verify before release'),
          t('先发，补验放下一版', 'Release first; verify next version'),
          t('不补', 'Skip verification'),
        ],
      ),
      decision(
        'D-17',
        t(
          'Pi 压缩失败那件事，网关那边要不要兜底',
          'Should the gateway handle Pi compaction failures?',
        ),
        t(
          'models.json 里的显式缓存项经 OAuth 直通被网关 400。你本机的配置已经改好；问题是要不要在 sub2api 里把这类请求降级处理，免得别人踩到。这是开放题，经理没有倾向。',
          'Explicit cache entries from models.json cause HTTP 400 through OAuth passthrough. The local configuration is fixed. Should sub2api downgrade these requests to protect other users? This is an open question without a recommendation.',
        ),
      ),
      decision(
        'D-13',
        t('子会话要不要算进后台任务', 'Should child sessions count as background tasks?'),
      ),
      decision(
        'D-11',
        t('定时任务回合里的审批没人答等多久', 'How long should scheduled runs wait for approval?'),
      ),
      decision('D-12', t('手机端要不要画 mermaid', 'Should mobile render Mermaid?')),
    ]
    const [d15, d16, d17, d13, d11, d12] = main.decisions
    if (d15) {
      d15.blocks = ['I-1', 'I-2']
      d15.default = { kind: 'option', optionId: 'a' }
      d15.basis = [
        { kind: 'thread', target: 'manager-k1', label: null },
        { kind: 'branch', target: 'feat/edit-to-rewind', label: null },
      ]
    }
    if (d16) {
      d16.blocks = ['I-4']
      d16.basis = [{ kind: 'file', target: '13-windows-desktop-acceptance.md', label: null }]
      d16.checked = { commit: null, at: ago(180) }
    }
    if (d17) {
      d17.basis = [{ kind: 'file', target: 'dev-notes/engine-pi.md', label: null }]
      d17.checked = { commit: null, at: ago(1440) }
    }
    for (const [entry, text, file] of [
      [d13, t('不算，子代理照算', 'No; subagents still count'), '23-background-tasks.md'],
      [
        d11,
        t('30 分钟后拒绝并记进运行记录', 'Decline after 30 minutes and record it in run history'),
        '11-scheduled-tasks.md',
      ],
    ] as const)
      if (entry) {
        entry.status = 'answered'
        entry.answer = { optionId: null, text, by: 'user', at: ago(19) }
        entry.landed = [{ kind: 'file', target: file, label: null }]
      }
    if (d12) {
      d12.status = 'expired'
      d12.closed = {
        reason: t(
          '已在 0.22.0 做完，feat/mobile-mermaid 已合进 main，不用再定',
          'Completed in 0.22.0; feat/mobile-mermaid is merged into main',
        ),
        by: 'manager',
        at: ago(55),
      }
    }
    const titles = [
      t('回退改成在原消息上编辑（桌面）', 'Edit original messages to rewind (desktop)'),
      t('回退编辑：手机端跟进', 'Rewind editing on mobile'),
      t('子会话归档：真实窗口补验', 'Verify child archiving in a real window'),
      t('Windows 真机补验', 'Verify on a Windows machine'),
      t('在 iPhone 上看一眼 mermaid 全屏', 'Check fullscreen Mermaid on iPhone'),
      t('后台任务页加筛选', 'Add background task filters'),
      t('恢复 CLI 自带的重试并显示次数', 'Restore CLI retries and show attempts'),
      t('手机端 mermaid', 'Mermaid on mobile'),
      t('子代理跑完仍显示进行中', 'Completed subagents still appear running'),
    ]
    const statuses = [
      'running',
      'blocked',
      'review',
      'blocked',
      'backlog',
      'backlog',
      'done',
      'done',
      'done',
    ] as const
    main.items = titles.map((title, i) => ({
      id: `I-${i + 1}`,
      title,
      status: statuses[i] ?? 'backlog',
      revision: 1,
      owner:
        i === 3 || i === 4
          ? { kind: 'user' }
          : i === 5 || i > 6
            ? { kind: 'manager' }
            : {
                kind: 'line',
                threadId: i < 2 ? 'manager-k1' : i === 2 ? 'manager-k2' : 'manager-k4',
              },
      blockedBy: i === 1 ? ['D-15'] : i === 3 ? ['D-16'] : [],
      why:
        i === 1
          ? t('等 D-15', 'Waiting for D-15')
          : i === 3
            ? t('等 D-16', 'Waiting for D-16')
            : '',
      links: [],
      basis: [],
      unverified: i === 2 ? [t('没验：真实窗口', 'Not verified: real window')] : [],
      checked: { commit: 'a9a85c1', at: ago(40) },
      createdAt: ago(180),
      updatedAt: ago(40),
    }))
    const reports = [
      t(
        '桌面端的编辑态做完了，确认后回退并发出。插话消息那块等决策。',
        'Desktop editing is complete: confirm to rewind and send. Steering messages await a decision.',
      ),
      t(
        '已提交 bdafb1a5：归档父会话时连带归档跑完的子会话。检查和单测都过了。',
        'Committed bdafb1a5: archiving a parent also archives completed children. Checks and tests passed.',
      ),
      '',
      t(
        '桌面和手机的状态行显示“重试中 x/y · 原因”。',
        'Desktop and mobile status lines show retry x/y and the reason.',
      ),
    ]
    const branches = [
      'feat/edit-to-rewind',
      'feat/archive-child-sessions',
      null,
      'fix/claude-cli-retry',
    ]
    main.lines = main.lines.map((line, i) => ({
      ...line,
      branch: branches[i] ?? null,
      ahead: i === 0 ? 3 : i === 1 ? 1 : null,
      merged: i === 3 ? true : i === 2 ? null : false,
      worktreeExists: i === 2 ? null : i !== 3,
      report: reports[i]
        ? { text: reports[i] ?? '', at: ago(i === 0 ? 12 : i === 1 ? 60 : 120) }
        : null,
      unverified:
        i === 0
          ? [t('没验：手机', 'Not verified: mobile'), t('没验：Codex', 'Not verified: Codex')]
          : i === 1
            ? [t('没验：真实窗口', 'Not verified: real window')]
            : [],
    }))
    const feed = [
      t(
        '线「回退改成编辑原消息」回报：3 个提交，手机和 Codex 没验',
        'Rewind editing reported: 3 commits; mobile and Codex not verified',
      ),
      t(
        '你答复了 D-13：子会话不算后台任务',
        'You answered D-13: child sessions are not background tasks',
      ),
      t('经理提了 D-15', 'Manager opened D-15'),
      t('fix/claude-cli-retry 合进 main', 'fix/claude-cli-retry merged into main'),
      t('经理关闭 D-12：已在 0.22.0 做完', 'Manager closed D-12: completed in 0.22.0'),
      t('你答复了 D-11：30 分钟', 'You answered D-11: 30 minutes'),
    ]
    main.activities = feed.map((text, i) => ({
      id: `activity-${i}`,
      text,
      kind: i === 0 ? 'report' : i === 3 ? 'merged' : 'decision',
      at: ago([12, 19, 28, 40, 55, 70][i] ?? 0),
      objectId: ([null, 'D-13', 'D-15', null, 'D-12', 'D-11'] as const)[i] ?? null,
      threadId: i === 0 ? 'manager-k1' : i === 3 ? 'manager-k4' : null,
      changeId: null,
    }))
  }
  const mobile = boards.find((board) => board.managerId === 'm3')
  if (mobile)
    mobile.decisions.push(
      decision('D-1', t('输入区高度采用哪种方案', 'Which composer height should we use?')),
    )
  const gateway = boards.find((board) => board.managerId === 'm2')
  if (gateway)
    gateway.situation = {
      text: t(
        '正在复现 522，并给上游加超时告警。',
        'Reproducing 522 errors and adding upstream timeout alerts.',
      ),
      at: ago(90),
    }
  if (mobile)
    mobile.activities.push({
      id: 'mobile-decision',
      kind: 'decision',
      at: ago(1440),
      text: t('经理提了 1 项决策', 'Manager opened one decision'),
      objectId: 'D-1',
      threadId: null,
      changeId: null,
    })
  if (gateway)
    gateway.activities.push({
      id: 'gateway-status',
      kind: 'status',
      at: ago(90),
      text: t('经理更新了现状', 'Manager updated the situation'),
      objectId: null,
      threadId: null,
      changeId: null,
    })
  const previous = boards.find((board) => board.managerId === 'e1')
  if (previous && main) {
    // 上一位经理留下的过程记录只读；不与当前看板共享可变对象。
    previous.decisions = JSON.parse(
      JSON.stringify(main.decisions.slice(0, 2)),
    ) as ManagerDecisionView[]
    previous.items = JSON.parse(JSON.stringify(main.items.slice(0, 3))) as ManagerBoardView['items']
  }
  for (const manager of managers) {
    const board = boards.find((board) => board.managerId === manager.id)
    manager.pendingDecisions = board?.decisions.filter((d) => d.status === 'open').length ?? 0
    manager.latestActivity = board?.activities[0] ?? null
  }
  return { managers, boards, sessions }
}
