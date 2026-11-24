// 飞书界面的纯逻辑（src/feishu/model.ts）：显示状态、原因代码、App ID 与机器人名校验、经理候选、
// 能力缺项与补申请条件、向导结束语。桌面和手机共用这一份。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const m = await import('../src/feishu/model.ts')

const app = (patch = {}) => ({
  appId: 'cli_0000000000000001',
  revision: 1,
  name: '助手',
  managerId: null,
  enabled: true,
  credential: { generation: 1, updatedAt: 0 },
  connection: { state: 'connected', since: 0, reconnects: 0 },
  capability: null,
  createdAt: 0,
  ...patch,
})

test('显示状态：停用优先，失败与重连带原因', () => {
  assert.equal(m.shownState(app()), 'connected')
  assert.equal(m.shownState(app({ enabled: false })), 'stopped')
  assert.equal(
    m.shownState(app({ connection: { state: 'stopped', since: 0, reconnects: 0 } })),
    'stopped',
  )
  const failed = app({
    connection: {
      state: 'failed',
      since: 0,
      reconnects: 3,
      error: { code: 'credential_rejected', at: 0 },
    },
  })
  assert.equal(m.shownState(failed), 'failed')
  assert.equal(m.STATE_TONE[m.shownState(failed)], 'err')
  assert.equal(m.connectionReason(failed), 'credential_rejected')
  // 已停用的不再说失败原因
  assert.equal(m.connectionReason({ ...failed, enabled: false }), null)
  assert.equal(m.connectionReason(app()), null)
})

test('原因代码：只认设备给的 feishu_ 代码', () => {
  assert.equal(m.feishuReason({ message: 'feishu_revision_conflict' }), 'revision_conflict')
  assert.equal(m.feishuReason({ message: 'feishu_manager_taken' }), 'manager_taken')
  assert.equal(m.feishuReason({ message: 'feishu_something_new' }), null)
  assert.equal(m.feishuReason({ message: 'Credential operation failed' }), null)
  assert.equal(m.feishuReason(null), null)
})

test('App ID 与机器人名校验', () => {
  assert.equal(m.validAppId('cli_a1b2c3d4e5f60718'), true)
  assert.equal(m.validAppId('cli_A1B2C3D4E5F60718'), false)
  assert.equal(m.validAppId('cli_a1b2'), false)
  assert.equal(m.botNameProblem('  '), 'empty')
  assert.equal(m.botNameProblem('助'.repeat(30)), null)
  assert.equal(m.botNameProblem('助'.repeat(31)), 'long')
  // 按字符数算：30 个表情不算超长
  assert.equal(m.botNameProblem('😀'.repeat(30)), null)
})

test('经理候选：已分给别的应用的标出来，当前经理不在列表时补上', () => {
  const apps = [
    app({ appId: 'cli_a', name: '甲', managerId: 'm1' }),
    app({ appId: 'cli_b', name: '乙', managerId: 'gone' }),
  ]
  const managers = [
    { id: 'm1', name: '经理一' },
    { id: 'm2', name: '经理二' },
  ]
  assert.deepEqual(m.managerOptions(apps, managers, 'cli_b'), [
    { id: 'm1', name: '经理一', takenBy: '甲' },
    { id: 'm2', name: '经理二', takenBy: null },
    { id: 'gone', name: 'gone', takenBy: null },
  ])
  assert.deepEqual(
    m.managerOptions(apps, managers, 'cli_a').map((one) => one.takenBy),
    [null, null],
  )
})

test('能力缺项与补申请：缺项且没有待审核版本才可补申请', () => {
  const capability = {
    checkedAt: 0,
    state: 'missing',
    missingScopes: ['im:message'],
    missingEvents: [],
    missingCallbacks: ['card.action.trigger'],
  }
  assert.deepEqual(
    m.missingGroups(capability).map((group) => group.kind),
    ['scopes', 'callbacks'],
  )
  assert.equal(m.canUpgrade(capability), true)
  const pending = { ...capability, publish: { state: 'pending_review', at: 0 } }
  assert.equal(m.pendingReview(pending), true)
  assert.equal(m.canUpgrade(pending), false)
  assert.equal(m.canUpgrade({ ...capability, state: 'ok' }), false)
  assert.equal(m.canUpgrade(null), false)
})

test('向导结束语：error 带原因时按原因说', () => {
  const base = { registrationId: 'r', revision: 2, name: 'x', expiresAt: 0 }
  assert.equal(m.registrationEnd({ ...base, state: 'succeeded', appId: 'cli_a' }), 'succeeded')
  assert.equal(m.registrationEnd({ ...base, state: 'expired' }), 'expired')
  assert.equal(m.registrationEnd({ ...base, state: 'error' }), 'error')
  assert.equal(
    m.registrationEnd({ ...base, state: 'error', error: 'lark_tenant' }),
    'error.lark_tenant',
  )
  assert.equal(m.secondsLeft(100, 40_500), 59)
  assert.equal(m.secondsLeft(100, 200_000), 0)
})

test('写权限：离线优先；admin 为 false 只读，还没读到（null）照常可写', () => {
  assert.equal(m.writeBlock(false, true), 'offline')
  assert.equal(m.writeBlock(false, false), 'offline')
  assert.equal(m.writeBlock(true, false), 'readOnly')
  assert.equal(m.writeBlock(true, true), null)
  assert.equal(m.writeBlock(true, null), null)
  assert.equal(m.writeBlock(true, undefined), null)
})

test('群的原因代码：认得出、该重读的会重读', () => {
  for (const code of ['chat_unavailable', 'external_unconfirmed', 'members_failed', 'sync_failed'])
    assert.equal(m.feishuReason({ message: `feishu_${code}` }), code)
  assert.equal(m.staleReason('revision_conflict'), true)
  assert.equal(m.staleReason('chat_accessed'), true)
  assert.equal(m.staleReason('chat_not_accessed'), true)
  assert.equal(m.staleReason('chat_unavailable'), false)
  assert.equal(m.staleReason(null), false)
})

const access = (patch = {}) => ({
  speech: 'free',
  wakeBound: true,
  wakers: [{ openId: 'ou_a', name: '甲' }],
  retentionDays: 90,
  reviewTtlHours: 24,
  accessAt: 0,
  ...patch,
})
const chat = (patch = {}) => ({
  appId: 'cli_a',
  chatId: 'oc_a',
  revision: 4,
  name: '项目群',
  external: false,
  status: 'normal',
  botPresent: true,
  access: null,
  updatedAt: 0,
  ...patch,
})

test('群的状态与排序：可用且已接入的在前，解散、机器人不在的在后', () => {
  assert.equal(m.chatAccessState(chat()), 'none')
  assert.equal(m.chatAccessState(chat({ access: access({ speech: 'approval' }) })), 'approval')
  assert.equal(m.chatUnavailable(chat()), null)
  assert.equal(m.chatUnavailable(chat({ botPresent: false })), 'botLeft')
  assert.equal(m.chatUnavailable(chat({ status: 'dissolved', botPresent: false })), 'dissolved')
  const sorted = m.sortChats([
    chat({ chatId: 'oc_left', botPresent: false, access: access() }),
    chat({ chatId: 'oc_new' }),
    chat({ chatId: 'oc_on', access: access() }),
    chat({ chatId: 'oc_new2' }),
  ])
  assert.deepEqual(
    sorted.map((one) => one.chatId),
    ['oc_on', 'oc_new', 'oc_new2', 'oc_left'],
  )
})

test('接入初值：不预选发言模式，外部群预选审批；默认值来自协议常量', () => {
  const plain = m.chatDraft(chat())
  assert.equal(plain.speech, null)
  assert.equal(plain.wakeBound, true)
  assert.equal(plain.retentionDays, '90')
  assert.equal(plain.reviewTtlHours, '24')
  assert.deepEqual(m.draftProblems(plain, chat()), ['speech'])
  const external = chat({ external: true })
  const draft = m.chatDraft(external)
  assert.equal(draft.speech, 'approval')
  // 外部群不勾确认不能提交
  assert.deepEqual(m.draftProblems(draft, external), ['external'])
  assert.equal(m.accessParams(draft, external), null)
  const confirmed = { ...draft, confirmExternal: true }
  assert.deepEqual(m.draftProblems(confirmed, external), [])
  assert.deepEqual(m.accessParams(confirmed, external), {
    appId: 'cli_a',
    chatId: 'oc_a',
    expectedRevision: 4,
    speech: 'approval',
    confirmExternal: true,
    wakeBound: true,
    wakers: [],
    retentionDays: 90,
    reviewTtlHours: 24,
  })
})

test('数字校验：只认范围内的整数；审批过期时间只在审批发言时校验', () => {
  const range = { min: 1, max: 168 }
  assert.equal(m.boundedInt(' 12 ', range), 12)
  assert.equal(m.boundedInt('0', range), null)
  assert.equal(m.boundedInt('169', range), null)
  assert.equal(m.boundedInt('1.5', range), null)
  assert.equal(m.boundedInt('', range), null)
  const free = { ...m.chatDraft(chat()), speech: 'free', reviewTtlHours: 'x' }
  assert.deepEqual(m.draftProblems(free, chat()), [])
  // 自由发言时填坏的过期时间不进参数，沿用默认值
  assert.equal(m.accessParams(free, chat()).reviewTtlHours, 24)
  assert.deepEqual(m.draftProblems({ ...free, speech: 'approval' }, chat()), ['ttl'])
  assert.deepEqual(m.draftProblems({ ...free, retentionDays: '3651' }, chat()), ['retention'])
})

test('群设置：只带改了的字段，名单按集合比较', () => {
  const current = access({
    wakers: [
      { openId: 'ou_a', name: '甲' },
      { openId: 'ou_b', name: '乙' },
    ],
  })
  const draft = m.chatDraft(chat({ access: current }))
  assert.deepEqual(m.chatChanges(draft, current), {})
  // 名单只换了顺序：不算改
  assert.deepEqual(m.chatChanges({ ...draft, wakers: [...draft.wakers].reverse() }, current), {})
  assert.deepEqual(m.chatChanges({ ...draft, speech: 'approval', retentionDays: '30' }, current), {
    speech: 'approval',
    retentionDays: 30,
  })
  assert.deepEqual(
    m.chatChanges(
      { ...draft, wakeBound: false, wakers: [{ openId: 'ou_c', name: '丙' }] },
      current,
    ),
    { wakeBound: false, wakers: ['ou_c'] },
  )
  assert.deepEqual(m.chatChanges({ ...draft, reviewTtlHours: '48' }, current), {
    reviewTtlHours: 48,
  })
})

test('成员选择：已选但不在成员里的排前，可搜，到上限不再加', () => {
  const members = [
    { openId: 'ou_a', name: 'Alice' },
    { openId: 'ou_b', name: '乙' },
  ]
  const selected = [
    { openId: 'ou_gone', name: '旧成员' },
    { openId: 'ou_a', name: 'Alice' },
  ]
  assert.deepEqual(
    m.memberChoices(members, selected).map((one) => [one.person.openId, one.listed]),
    [
      ['ou_gone', false],
      ['ou_a', true],
      ['ou_b', true],
    ],
  )
  assert.deepEqual(
    m.memberChoices(members, selected, 'ALI').map((one) => one.person.openId),
    ['ou_a'],
  )
  // 成员还没读到：只列已选的，不标“不在群成员中”
  assert.deepEqual(
    m.memberChoices(null, selected).map((one) => one.listed),
    [true, true],
  )
  assert.deepEqual(
    m.toggleWaker(selected, members[0]).map((one) => one.openId),
    ['ou_gone'],
  )
  assert.equal(m.toggleWaker(selected, members[1]).length, 3)
  const full = Array.from({ length: m.FEISHU_WAKERS_MAX }, (_, i) => ({
    openId: `ou_${i}`,
    name: `${i}`,
  }))
  assert.equal(m.toggleWaker(full, members[1]).length, m.FEISHU_WAKERS_MAX)
  assert.deepEqual(
    m.draftProblems(
      { ...m.chatDraft(chat()), speech: 'free', wakers: [...full, members[1]] },
      chat(),
    ),
    ['wakers'],
  )
})

test('未接入（有记录）与补历史中', () => {
  assert.equal(m.chatAccessState(chat({ records: { messages: 41 } })), 'kept')
  assert.equal(m.chatAccessState(chat()), 'none')
  assert.equal(m.chatAccessState(chat({ access: access(), records: { messages: 3 } })), 'free')
  const running = {
    messages: 3,
    backfill: {
      kind: 'access',
      state: 'running',
      start: 0,
      end: 10,
      fetched: 3,
      truncated: false,
      startedAt: 0,
    },
  }
  assert.equal(m.backfilling(chat({ access: access(), records: running })), true)
  // 取消接入后留着的记录不算正在补
  assert.equal(m.backfilling(chat({ records: running })), false)
})

test('补历史的结果用哪句', () => {
  assert.equal(m.backfillLine({ state: 'running', truncated: false }), 'running')
  assert.equal(m.backfillLine({ state: 'done', truncated: false }), 'done')
  assert.equal(m.backfillLine({ state: 'done', truncated: true }), 'truncated')
  assert.equal(m.backfillLine({ state: 'failed', truncated: true }), 'failed')
})

test('手动补历史为什么不能做：写权限、群能不能用、接入、正在补依次判断', () => {
  const on = chat({ access: access() })
  assert.equal(m.backfillBlock(on, null), null)
  assert.equal(m.backfillBlock(on, 'readOnly'), 'readOnly')
  assert.equal(m.backfillBlock(on, 'offline'), 'offline')
  assert.equal(m.backfillBlock({ ...on, botPresent: false }, null), 'botLeft')
  assert.equal(m.backfillBlock({ ...on, status: 'dissolved' }, null), 'dissolved')
  assert.equal(m.backfillBlock(chat({ records: { messages: 2 } }), null), 'notAccessed')
  const running = {
    messages: 1,
    backfill: {
      kind: 'manual',
      state: 'running',
      start: 0,
      end: 1,
      fetched: 0,
      truncated: false,
      startedAt: 0,
    },
  }
  assert.equal(m.backfillBlock({ ...on, records: running }, null), 'running')
})

test('补历史窗口：开始取本地零点，结束取次日零点与现在中较早的', () => {
  const local = (y, mo, d, h = 0) => new Date(y, mo - 1, d, h).getTime()
  const now = local(2026, 3, 10, 15)
  assert.deepEqual(m.backfillWindow('2026-03-01', '2026-03-05', now), {
    start: local(2026, 3, 1) / 1000,
    end: local(2026, 3, 6) / 1000,
  })
  // 结束日期是今天：截到现在
  assert.deepEqual(m.backfillWindow('2026-03-09', '2026-03-10', now), {
    start: local(2026, 3, 9) / 1000,
    end: now / 1000,
  })
  // 同一天也行（一整天的窗口）
  assert.equal('start' in m.backfillWindow('2026-03-05', '2026-03-05', now), true)
  assert.deepEqual(m.backfillWindow('2026-03-06', '2026-03-05', now), { problem: 'order' })
  // 开始在今天之后
  assert.deepEqual(m.backfillWindow('2026-03-11', '2026-03-12', now), { problem: 'order' })
  assert.deepEqual(m.backfillWindow('2026-02-30', '2026-03-05', now), { problem: 'format' })
  assert.deepEqual(m.backfillWindow('2026/03/01', '2026-03-05', now), { problem: 'format' })
  assert.equal(m.dayText(local(2026, 3, 9, 23)), '2026-03-09')
  // 窗口显示成日期：结束不含，显示前一天
  assert.deepEqual(m.windowDays(local(2026, 3, 1) / 1000, local(2026, 3, 6) / 1000), {
    from: '2026-03-01',
    to: '2026-03-05',
  })
  assert.deepEqual(m.backfillDefaults({ oldestAt: local(2026, 3, 1) / 1000 }, now), {
    from: '2026-01-30',
    to: '2026-03-10',
  })
  assert.deepEqual(m.backfillDefaults(undefined, now), { from: '2026-02-08', to: '2026-03-10' })
})

test('补历史的两个原因代码认得出', () => {
  assert.equal(m.feishuReason({ message: 'feishu_backfill_running' }), 'backfill_running')
  assert.equal(
    m.feishuReason({ message: 'feishu_backfill_window_invalid' }),
    'backfill_window_invalid',
  )
})

// ---------- 经理的飞书收件箱 ----------

const entry = (inboxId, patch = {}) => ({
  inboxId,
  status: 'queued',
  appId: 'cli_0000000000000001',
  managerId: 'm1',
  chatId: 'oc_1',
  chatKind: 'group',
  messageId: `om_${inboxId}`,
  senderOpenId: 'ou_1',
  senderIdentity: 'member',
  trigger: 'mention',
  createdAt: 0,
  receivedAt: 0,
  ...patch,
})
const message = (patch = {}) => ({
  chatName: '项目群',
  text: '你好',
  msgType: 'text',
  state: 'normal',
  purged: false,
  ...patch,
})

test('收件箱分段：排队中和已送进回合算待处理，已处理单列，顺序不变', () => {
  const all = [
    entry('FI-4'),
    entry('FI-3', { status: 'processed' }),
    entry('FI-2', { status: 'notified' }),
    entry('FI-1', { status: 'processed' }),
  ]
  assert.deepEqual(
    m.segmentEntries(all, 'open').map((one) => one.inboxId),
    ['FI-4', 'FI-2'],
  )
  assert.deepEqual(
    m.segmentEntries(all, 'done').map((one) => one.inboxId),
    ['FI-3', 'FI-1'],
  )
  assert.equal(m.queuedCount(all), 1)
  assert.equal(m.queuedCount([]), 0)
})

test('收件箱合并：同一条以订阅为准，更早的只补没有的', () => {
  const merged = m.mergeInbox(
    { entries: [entry('FI-3', { status: 'processed' })], messages: { 'FI-3': message() } },
    {
      entries: [entry('FI-3'), entry('FI-2')],
      messages: { 'FI-3': message({ text: '旧' }), 'FI-2': message({ text: '更早' }) },
    },
  )
  assert.deepEqual(
    merged.entries.map((one) => [one.inboxId, one.status]),
    [
      ['FI-3', 'processed'],
      ['FI-2', 'queued'],
    ],
  )
  assert.equal(merged.messages['FI-3'].text, '你好')
  assert.equal(merged.messages['FI-2'].text, '更早')
})

test('收件箱行：限额只标在排队中的条目上，发送人没名字用 open_id', () => {
  assert.equal(m.inboxShownStatus({ status: 'queued', note: 'rate_limited' }), 'limited')
  assert.equal(m.inboxShownStatus({ status: 'notified', note: 'rate_limited' }), 'notified')
  assert.equal(m.inboxShownStatus({ status: 'processed' }), 'processed')
  assert.equal(m.senderLabel({ senderName: '甲', senderOpenId: 'ou_1' }), '甲')
  assert.equal(m.senderLabel({ senderName: '  ', senderOpenId: 'ou_1' }), 'ou_1')
  assert.equal(m.senderLabel({ senderOpenId: 'ou_2' }), 'ou_2')
})

test('收件箱正文：撤回、删除优先于保留期，没字的按消息类型说', () => {
  assert.deepEqual(m.inboxText(message()), { kind: 'text', text: '你好' })
  assert.deepEqual(m.inboxText(message({ state: 'recalled', text: null })), { kind: 'recalled' })
  assert.deepEqual(m.inboxText(message({ state: 'deleted' })), { kind: 'deleted' })
  assert.deepEqual(m.inboxText(message({ text: null, purged: true })), { kind: 'purged' })
  assert.deepEqual(m.inboxText(message({ text: null, msgType: 'image' })), {
    kind: 'other',
    msgType: 'image',
  })
  assert.deepEqual(m.inboxText(undefined), { kind: 'missing' })
})

test('收件箱群名：有群名用群名，私聊没有，群没有名字时用 chat_id', () => {
  assert.equal(m.inboxChatName(entry('FI-1'), message()), '项目群')
  assert.equal(m.inboxChatName(entry('FI-1'), undefined), 'oc_1')
  assert.equal(m.inboxChatName(entry('FI-1', { chatKind: 'p2p' }), message({ chatName: '' })), null)
})

// ---------- 审批与发件 ----------

const NOW = 1_000_000_000 * 1000
const review = (patch = {}) => ({
  reviewId: 'A-1',
  revision: 1,
  kind: 'speech',
  provider: 'feishu',
  scope: 'cli_0000000000000001/oc_x',
  subjectRef: 'op_1',
  requestedBy: { managerId: 'm1' },
  preview: {
    kind: 'speech',
    provider: 'feishu',
    appId: 'cli_0000000000000001',
    appName: '助手',
    target: { kind: 'chat', id: 'oc_x', name: '测试群' },
    actingAs: { type: 'bot' },
    mentions: [],
    parts: [{ format: 'text', text: '你好' }],
  },
  payloadHash: '0'.repeat(64),
  state: 'pending',
  createdAt: NOW / 1000 - 60,
  expiresAt: NOW / 1000 + 3600,
  ...patch,
})

test('审批原因代码：只认 review_ 四种，都要重读', () => {
  assert.equal(m.reviewReason({ message: 'review_revision_conflict' }), 'review_revision_conflict')
  assert.equal(m.reviewReason({ message: 'review_expired' }), 'review_expired')
  assert.equal(m.reviewReason({ message: 'feishu_app_not_found' }), null)
  assert.equal(m.reviewReason(new Error('review_other')), null)
  assert.equal(m.reviewReason(null), null)
  assert.equal(m.reviewStale('review_not_pending'), true)
  assert.equal(m.reviewStale(null), false)
  // 撤下发件的两个原因并进 feishu_ 代码
  assert.equal(m.feishuReason({ message: 'feishu_outbox_sending' }), 'outbox_sending')
  assert.equal(m.feishuReason({ message: 'feishu_outbox_not_found' }), 'outbox_not_found')
})

test('审批显示状态：待批但过了过期时间显示成已过期', () => {
  assert.equal(m.reviewShownState(review(), NOW), 'pending')
  assert.equal(m.reviewShownState(review({ expiresAt: NOW / 1000 }), NOW), 'expired')
  assert.equal(m.reviewShownState(review({ state: 'approved', expiresAt: 0 }), NOW), 'approved')
})

test('审批排序：待批在前且快过期的在前，其余按有结果的时间新的在前', () => {
  const list = [
    review({ reviewId: 'A-1', state: 'rejected', decidedAt: 100, createdAt: 50 }),
    review({ reviewId: 'A-2', expiresAt: NOW / 1000 + 7200 }),
    review({ reviewId: 'A-3', state: 'expired', createdAt: 300 }),
    review({ reviewId: 'A-4', expiresAt: NOW / 1000 + 600 }),
    review({ reviewId: 'A-5', expiresAt: NOW / 1000 - 1, createdAt: 200 }),
  ]
  assert.deepEqual(
    m.sortReviews(list, NOW).map((one) => one.reviewId),
    ['A-4', 'A-2', 'A-3', 'A-5', 'A-1'],
  )
})

test('待批数：用设备给的总数，扣掉列表里已过期没改的', () => {
  assert.equal(m.pendingReviewCount(undefined, NOW), 0)
  const reviews = [review(), review({ reviewId: 'A-2', expiresAt: NOW / 1000 - 5 })]
  assert.equal(m.pendingReviewCount({ reviews, pending: 2 }, NOW), 1)
  // 总数超过列表（设备只给前 200 条）时照总数算
  assert.equal(m.pendingReviewCount({ reviews: [review()], pending: 250 }, NOW), 250)
})

test('剩余时间：天、小时向下取整，不到一小时按分钟向上取整并标提醒', () => {
  const at = (seconds) => NOW / 1000 + seconds
  assert.deepEqual(m.timeLeft(at(86_400 * 2 + 5), NOW), { unit: 'day', n: 2, soon: false })
  assert.deepEqual(m.timeLeft(at(86_399), NOW), { unit: 'hour', n: 23, soon: false })
  assert.deepEqual(m.timeLeft(at(3600), NOW), { unit: 'hour', n: 1, soon: false })
  assert.deepEqual(m.timeLeft(at(3599), NOW), { unit: 'minute', n: 60, soon: true })
  assert.deepEqual(m.timeLeft(at(5), NOW), { unit: 'minute', n: 1, soon: true })
  assert.equal(m.timeLeft(at(0), NOW), null)
})

test('发言开头与格式标记：取第一行有字的，图片文件取名字；格式去重', () => {
  assert.equal(m.speechHead([{ format: 'post', text: '\n  第一行 \n第二行' }]), '第一行')
  assert.equal(m.speechHead([{ format: 'image', name: '图.png', size: 1 }]), '图.png')
  assert.equal(
    m.speechHead([
      { format: 'image', name: '图.png', size: 1 },
      { format: 'text', text: '说明' },
    ]),
    '说明',
  )
  assert.equal(m.speechHead([]), '')
  assert.deepEqual(m.speechFormats([{ format: 'card' }, { format: 'text' }, { format: 'card' }]), [
    'card',
    'text',
  ])
})

test('批准参数：带 revision，理由去空白，空理由不带；理由按字符数限长', () => {
  assert.deepEqual(m.decideParams(review({ revision: 3 }), 'approve', '  '), {
    reviewId: 'A-1',
    decision: 'approve',
    expectedRevision: 3,
  })
  assert.deepEqual(m.decideParams(review(), 'reject', ' 不合适 '), {
    reviewId: 'A-1',
    decision: 'reject',
    expectedRevision: 1,
    reason: '不合适',
  })
  assert.equal(m.reasonProblem('字'.repeat(500)), null)
  assert.equal(m.reasonProblem('字'.repeat(501)), 'long')
  // 补充平面字符按一个字算
  assert.equal(m.reasonProblem('😀'.repeat(500)), null)
})

test('发件：能撤下的状态、原因文案、合并更早的页', () => {
  assert.deepEqual(
    [
      'awaiting_approval',
      'queued',
      'sending',
      'sent',
      'failed',
      'rejected',
      'canceled',
      'unknown',
    ].filter((state) => m.canCancelOutbox(state)),
    ['awaiting_approval', 'queued', 'unknown'],
  )
  assert.equal(m.outboxReason({ state: 'sent' }), null)
  // 被拒且是审批被拒：状态已说明，不再重复
  assert.equal(m.outboxReason({ state: 'rejected', error: 'review_rejected' }), null)
  assert.equal(m.outboxReason({ state: 'rejected', error: 'review_expired' }), 'review_expired')
  assert.equal(m.outboxReason({ state: 'unknown', error: 'unknown_timeout' }), 'unknown_timeout')
  assert.equal(m.outboxReason({ state: 'failed', error: 'rate_limited' }), 'other')
  const entry = (operationId, state = 'sent') => ({ operationId, state })
  assert.deepEqual(
    m
      .mergeOutbox([entry('b', 'queued'), entry('a')], [entry('b', 'sent'), entry('z')])
      .map((one) => `${one.operationId}:${one.state}`),
    ['b:queued', 'a:sent', 'z:sent'],
  )
})

test('私聊绑定：配对码规范化与格式', () => {
  assert.equal(m.pairingCode('ABCD-EFGH'), 'ABCD-EFGH')
  assert.equal(m.pairingCode(' abcd efgh '), 'ABCD-EFGH')
  assert.equal(m.pairingCode('abcdefgh'), 'ABCD-EFGH')
  assert.equal(m.pairingCode('ABCD-EFG'), null)
  // 字母表里没有 0 1 I L O
  assert.equal(m.pairingCode('ABCD-EFG0'), null)
  assert.equal(m.pairingCode('ABCD-EFGI'), null)
  assert.equal(m.pairingCodeBad(''), false)
  assert.equal(m.pairingCodeBad('abc'), false)
  assert.equal(m.pairingCodeBad('abco'), true)
  assert.equal(m.pairingCodeBad('ABCD-EFGHJ'), true)
  assert.equal(m.pairingCodeBad('AB#D'), true)
})

const binding = (openId, patch = {}) => ({
  appId: 'cli_0000000000000001',
  openId,
  revision: 1,
  name: '',
  state: 'bound',
  approver: false,
  retentionDays: 90,
  boundAt: 0,
  ...patch,
})

test('私聊绑定：名字、创建者、排序', () => {
  assert.equal(m.bindingName(binding('ou_a', { name: '甲' })), '甲')
  assert.equal(m.bindingName(binding('ou_a', { name: '  ' })), 'ou_a')
  assert.equal(m.bindingName({ openId: 'ou_b' }), 'ou_b')
  assert.equal(m.bindingIsCreator(binding('ou_a'), { creatorOpenId: 'ou_a' }), true)
  assert.equal(m.bindingIsCreator(binding('ou_a'), { creatorOpenId: 'ou_b' }), false)
  assert.equal(m.bindingIsCreator(binding('ou_a'), {}), false)
  assert.equal(m.bindingIsCreator(binding('ou_a'), null), false)
  const sorted = m.sortBindings([
    binding('old', { boundAt: 10 }),
    binding('gone', { state: 'revoked', boundAt: 50, revokedAt: 60 }),
    binding('new', { boundAt: 30 }),
    binding('gone2', { state: 'revoked', boundAt: 1, revokedAt: 70 }),
    binding('same', { boundAt: 10 }),
  ])
  assert.deepEqual(
    sorted.map((one) => one.openId),
    ['new', 'old', 'same', 'gone2', 'gone'],
  )
})

test('私聊绑定：快照与手里更新的合并', () => {
  const merged = m.mergeBindings(
    [binding('a', { revision: 2 }), binding('b', { revision: 3 })],
    [binding('a', { revision: 3, approver: true }), binding('b', { revision: 2 }), binding('c')],
  )
  assert.deepEqual(
    merged.map((one) => `${one.openId}:${one.revision}`),
    ['a:3', 'b:3', 'c:1'],
  )
  assert.equal(merged[0].approver, true)
  assert.equal(m.feishuReason({ message: 'feishu_pairing_not_found' }), 'pairing_not_found')
  assert.equal(m.staleReason('binding_revoked'), true)
  assert.equal(m.staleReason('pairing_not_found'), false)
})
