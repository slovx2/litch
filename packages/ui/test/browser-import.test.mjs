// “从浏览器导入”对话框里不靠浏览器就能测的那几块（src/settings/browser-import-logic.ts）：哪些来源、资料、类别能选；
// 默认勾哪几类；网站名单怎么认；拼出来的请求；进度只往前走；结果归纳成哪一句、能不能重试；对话框的阶段怎么换；
// 横幅出不出；两种语言的文案键齐全。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const logic = await import('../src/settings/browser-import-logic.ts')
const {
  advance,
  defaultKinds,
  defaultProfile,
  domainOf,
  draftFor,
  importStep,
  initialDraft,
  kindLook,
  kindReport,
  mergeOutcome,
  orderSources,
  parseDomains,
  pickedKinds,
  reportOf,
  requestOf,
  retryRequest,
  showBanner,
  sourceBlock,
  stagesOf,
  hitsAppBound,
  wantsSystemAuth,
} = logic
const { translator } = await import('../src/i18n/index.ts')

const has = (cookies, passwords) => ({ cookies, passwords })
const profile = (id, patch = {}) => ({
  id,
  name: id,
  isDefault: false,
  has: has(true, true),
  ...patch,
})
const chrome = {
  browser: 'chrome',
  name: 'Google Chrome',
  kinds: ['cookies', 'passwords'],
  promptsSystemAuth: true,
  needsElevation: false,
  profiles: [
    profile('Profile 1'),
    profile('Default', { isDefault: true, account: 'me@example.com' }),
  ],
}
const firefox = {
  browser: 'firefox',
  name: 'Firefox',
  kinds: ['cookies'],
  promptsSystemAuth: false,
  needsElevation: false,
  profiles: [profile('abc.default-release', { isDefault: true, has: has(true, true) })],
}
const edgeEmpty = {
  browser: 'edge',
  name: 'Microsoft Edge',
  kinds: ['cookies', 'passwords'],
  promptsSystemAuth: false,
  needsElevation: true,
  profiles: [],
}
const braveNothing = {
  browser: 'brave',
  name: 'Brave',
  kinds: ['cookies'],
  promptsSystemAuth: false,
  needsElevation: false,
  profiles: [profile('Default', { isDefault: true, has: has(false, true) })],
}

const counts = (patch = {}) => ({
  status: 'ok',
  discovered: 10,
  imported: 10,
  skippedExisting: 0,
  skippedInvalid: 0,
  failed: 0,
  ...patch,
})

test('一类能不能勾：读取器读不了的、资料里没有的各有原因', () => {
  const [ffProfile] = firefox.profiles
  assert.equal(kindLook(firefox, ffProfile, 'cookies'), 'ok')
  assert.equal(kindLook(firefox, ffProfile, 'passwords'), 'unsupported')
  assert.equal(kindLook(braveNothing, braveNothing.profiles[0], 'cookies'), 'missing')
  assert.equal(kindLook(chrome, undefined, 'cookies'), 'missing')
})

test('来源选不了的原因；能选的排在前面，其余照原顺序', () => {
  assert.equal(sourceBlock(chrome), null)
  assert.equal(sourceBlock(edgeEmpty), 'noProfiles')
  assert.equal(sourceBlock(braveNothing), 'nothing')
  const order = orderSources([edgeEmpty, chrome, braveNothing, firefox]).map((one) => one.browser)
  assert.deepEqual(order, ['chrome', 'firefox', 'edge', 'brave'])
})

test('默认资料是浏览器自己的默认那份；默认勾 Cookie 和密码', () => {
  assert.equal(defaultProfile(chrome).id, 'Default')
  // 默认那份导不了：用第一份能导的
  const odd = {
    ...chrome,
    profiles: [profile('Default', { isDefault: true, has: has(false, false) }), profile('Work')],
  }
  assert.equal(defaultProfile(odd).id, 'Work')
  assert.deepEqual(defaultKinds(chrome, chrome.profiles[1]), has(true, true))
  // 读取器不支持的不勾
  assert.deepEqual(defaultKinds(firefox, firefox.profiles[0]), has(true, false))
  assert.deepEqual(Object.keys(defaultKinds(chrome, chrome.profiles[1])), ['cookies', 'passwords'])
})

test('表单初值、换来源时类别回到默认、名单留着', () => {
  assert.equal(initialDraft([edgeEmpty, braveNothing]), null)
  const draft = initialDraft([edgeEmpty, firefox, chrome])
  assert.equal(draft.browser, 'firefox')
  assert.equal(draft.profileId, 'abc.default-release')
  const edited = { ...draft, onlyDomains: true, domainsText: 'github.com' }
  const next = draftFor(chrome, undefined, edited)
  assert.equal(next.browser, 'chrome')
  assert.equal(next.profileId, 'Default')
  assert.deepEqual(next.kinds, has(true, true))
  assert.equal(next.onlyDomains, true)
  assert.equal(next.domainsText, 'github.com')
  assert.equal('allowElevated' in next, false)
  // 指定的资料选得了就用它
  assert.equal(draftFor(chrome, 'Profile 1').profileId, 'Profile 1')
  assert.equal(draftFor(chrome, 'nope').profileId, 'Default')
})

test('网站名单：网址取主机，前导点、*.、端口、路径不要，大小写统一，重复的只留一个', () => {
  assert.equal(domainOf('https://Accounts.Example.com/login?x=1'), 'accounts.example.com')
  assert.equal(domainOf('.example.com'), 'example.com')
  assert.equal(domainOf('*.example.com'), 'example.com')
  assert.equal(domainOf('example.com:8443/path'), 'example.com')
  assert.equal(domainOf('example.com.'), 'example.com')
  assert.equal(domainOf('localhost'), 'localhost')
  assert.equal(domainOf('127.0.0.1'), '127.0.0.1')
  assert.equal(domainOf('例子.测试'), 'xn--fsqu00a.xn--0zwm56d')
  assert.equal(domainOf(''), null)
  assert.equal(domainOf('a_b.com'), null)
  assert.equal(domainOf('-bad.com'), null)
  assert.equal(domainOf('http://'), null)
  assert.deepEqual(parseDomains(' github.com, GitHub.com\nexample.org；foo_bar  .x.dev，'), {
    domains: ['github.com', 'example.org', 'x.dev'],
    bad: ['foo_bar'],
  })
  assert.deepEqual(parseDomains('  '), { domains: [], bad: [] })
})

test('提示：系统授权、这一版导不了受保护的那部分只在勾了 Cookie 或密码时出', () => {
  assert.equal(wantsSystemAuth(chrome, []), false)
  assert.equal(wantsSystemAuth(chrome, ['passwords']), true)
  assert.equal(wantsSystemAuth(firefox, ['cookies']), false)
  const edge = { ...edgeEmpty, profiles: [profile('Default')] }
  assert.equal(hitsAppBound(edge, ['cookies']), true)
  assert.equal(hitsAppBound(edge, []), false)
  assert.equal(hitsAppBound(chrome, ['cookies']), false)
})

test('拼请求：只带勾了又能导的；名单只在勾了 Cookie 时用；这一版一律不提权', () => {
  const edge = { ...edgeEmpty, profiles: [profile('Default', { isDefault: true })] }
  const sources = [chrome, firefox, edge]
  const draft = draftFor(chrome, undefined)
  assert.deepEqual(requestOf(sources, draft), {
    request: {
      browser: 'chrome',
      profileId: 'Default',
      kinds: ['cookies', 'passwords'],
      allowElevated: false,
    },
  })
  // 要管理员同意的来源也不发 true
  assert.equal(requestOf(sources, draftFor(edge, undefined)).request.allowElevated, false)
  // 一类都没勾
  assert.deepEqual(requestOf(sources, { ...draft, kinds: has(false, false) }), {
    problem: 'noKinds',
  })
  // 勾了读不了的那一类不算
  const ff = { ...draftFor(firefox, undefined), kinds: has(false, true) }
  assert.deepEqual(pickedKinds(sources, ff), [])
  assert.equal(requestOf(sources, ff).problem, 'noKinds')
  // 名单
  const only = { ...draft, onlyDomains: true }
  assert.deepEqual(requestOf(sources, { ...only, domainsText: '' }), { problem: 'noDomains' })
  assert.deepEqual(requestOf(sources, { ...only, domainsText: 'ok.com, b@d' }), {
    problem: 'badDomains',
    bad: ['b@d'],
  })
  assert.deepEqual(
    requestOf(sources, { ...only, domainsText: 'https://GitHub.com/x' }).request.cookieDomains,
    ['github.com'],
  )
  // 没勾 Cookie 时名单不发、写错了也不拦
  const noCookies = { ...only, domainsText: 'b@d', kinds: has(false, true) }
  const built = requestOf(sources, noCookies)
  assert.equal(built.request.cookieDomains, undefined)
  // 来源或资料不在了
  assert.deepEqual(requestOf(sources, { ...draft, profileId: 'gone' }), { problem: 'noSource' })
})

test('进度只往前走，不是这次要导的类别不理', () => {
  let stages = stagesOf(['passwords'])
  assert.deepEqual(stages, { passwords: 'waiting' })
  stages = advance(stages, { kind: 'passwords', phase: 'writing' })
  stages = advance(stages, { kind: 'passwords', phase: 'reading' })
  assert.equal(stages.passwords, 'writing')
  const same = advance(stages, { kind: 'cookies', phase: 'done' })
  assert.equal(same, stages)
  stages = advance(stages, { kind: 'passwords', phase: 'done' })
  assert.deepEqual(stages, { passwords: 'done' })
})

// 主进程没读成的一类：条数全是 0（pipeline.mts 的 notRead）
const none = (status, patch = {}) => counts({ status, discovered: 0, imported: 0, ...patch })

test('一类的结果：每种状态的语气、说法、能不能重试', () => {
  const look = (patch) => {
    const line = kindReport('cookies', counts(patch))
    return [line.tone, line.say, line.retry]
  }
  assert.deepEqual(look({}), ['ok', 'bimport.status.ok', false])
  assert.deepEqual(look({ failed: 2 }), ['warn', 'bimport.status.okFailed', true])
  assert.deepEqual(look({ discovered: 0, imported: 0 }), ['quiet', 'bimport.status.empty', false])
  // 一条新的都没有：都已经有了、都无效
  assert.deepEqual(look({ imported: 0, skippedExisting: 10 }), [
    'quiet',
    'bimport.status.allExisting',
    false,
  ])
  assert.deepEqual(look({ imported: 0, skippedInvalid: 3 }), [
    'warn',
    'bimport.status.allInvalid',
    false,
  ])
  // partial、failed 说法中性；读取器会报 partial 但 failed 是 0、只有一句 error
  assert.deepEqual(look({ status: 'partial', failed: 3 }), ['warn', 'bimport.status.partial', true])
  assert.deepEqual(look({ status: 'partial', failed: 0, error: 'x' }), [
    'warn',
    'bimport.status.partial',
    true,
  ])
  assert.deepEqual(look({ status: 'missing' }), ['quiet', 'bimport.status.missing', false])
  assert.deepEqual(look({ status: 'locked' }), ['err', 'bimport.status.locked', true])
  assert.deepEqual(look({ status: 'denied' }), ['err', 'bimport.status.denied', true])
  // 这一版不提权：说明导不了，不给重试
  assert.deepEqual(look({ status: 'needs-elevation' }), [
    'warn',
    'bimport.status.needsElevation',
    false,
  ])
  assert.deepEqual(look({ status: 'unsupported' }), ['quiet', 'bimport.status.unsupported', false])
  assert.deepEqual(look({ status: 'cancelled' }), ['quiet', 'bimport.status.cancelled', false])
  assert.deepEqual(look({ status: 'failed' }), ['err', 'bimport.status.failed', true])
  assert.deepEqual(look({ status: 'skipped' }), ['quiet', 'bimport.status.skipped', false])
  // 密码库用不了：重试也没用，不给重试（原话是 browser/passwords/store.mts 的那句）
  const keystore =
    'Saved passwords are encrypted with the system keystore, which is not available on this computer, so no passwords were stored.'
  assert.equal(logic.storeUnavailable(keystore), true)
  assert.equal(logic.storeUnavailable('Could not write to the built-in browser.'), false)
  assert.equal(logic.storeUnavailable(undefined), false)
  const store = kindReport('passwords', none('failed', { failed: 3, error: keystore }))
  assert.deepEqual(
    [store.tone, store.say, store.retry],
    ['err', 'bimport.status.storeUnavailable', false],
  )
  const half = kindReport('passwords', counts({ status: 'partial', failed: 1, error: keystore }))
  assert.equal(half.retry, false)
  // 主进程没报这一类：当没成，能重试
  const lost = kindReport('passwords', undefined)
  assert.equal(lost.status, 'failed')
  assert.equal(lost.retry, true)
  // 英文原话只放进详情
  assert.equal(kindReport('cookies', counts({ status: 'failed', error: 'disk' })).error, 'disk')
  assert.equal('error' in kindReport('cookies', counts()), false)
  // 条数：成了的、停下时写进去了的都写，没读成的不写
  assert.equal(logic.showsCounts(kindReport('cookies', counts())), true)
  assert.equal(
    logic.showsCounts(kindReport('cookies', counts({ status: 'cancelled', imported: 4 }))),
    true,
  )
  assert.equal(logic.showsCounts(kindReport('cookies', none('locked'))), false)
})

test('整次的结果：全成、部分成、都没成、没有新的、什么都没导、停了、资料不在、另一个在导', () => {
  const kinds = ['cookies', 'passwords']
  const of = (record, error, stopped) =>
    reportOf(kinds, { ...(error ? { error } : {}), kinds: record }, stopped)
  const all = { cookies: counts(), passwords: counts() }
  assert.equal(of(all).overall, 'ok')
  assert.equal(of(all).say, 'bimport.overall.ok')
  // 没数据的不拖累：一类成、一类没有
  assert.equal(of({ ...all, passwords: none('missing') }).overall, 'ok')
  assert.equal(of({ ...all, cookies: counts({ failed: 1 }) }).overall, 'partial')
  const mixed = of({ ...all, cookies: none('locked') })
  assert.equal(mixed.overall, 'partial')
  assert.deepEqual(mixed.again, ['cookies'])
  const bad = of({ cookies: none('locked'), passwords: none('needs-elevation') })
  assert.equal(bad.overall, 'failed')
  assert.deepEqual(bad.again, ['cookies'])
  assert.equal('elevate' in bad, false)
  // 只有这一版导不了的那部分没进来：算部分导入，不算失败
  assert.equal(of({ ...all, cookies: none('needs-elevation') }).overall, 'partial')
  assert.equal(
    of({ cookies: none('needs-elevation'), passwords: none('missing') }).overall,
    'nothing',
  )
  // 一类都没导成，也没有出错的：不说“导入完成”
  const empty = of({ cookies: none('missing'), passwords: none('unsupported') })
  assert.equal(empty.overall, 'nothing')
  assert.equal(empty.say, 'bimport.overall.nothing')
  assert.equal(of({ cookies: none('ok'), passwords: none('missing') }).overall, 'nothing')
  assert.equal(
    of({ cookies: counts({ imported: 0, skippedInvalid: 5 }), passwords: none('missing') }).overall,
    'nothing',
  )
  // 都已经有了
  const again = of({
    cookies: counts({ imported: 0, skippedExisting: 7 }),
    passwords: counts({ imported: 0, skippedExisting: 2 }),
  })
  assert.equal(again.overall, 'existing')
  assert.equal(again.say, 'bimport.overall.existing')
  // 停下：有 cancelled 的、只有 skipped 的（停在两类之间）、用户点过停止的
  assert.equal(
    of({ cookies: counts({ status: 'cancelled', imported: 3 }), passwords: none('skipped') })
      .overall,
    'cancelled',
  )
  assert.equal(of({ cookies: counts(), passwords: none('skipped') }).overall, 'cancelled')
  assert.equal(of(all, undefined, true).overall, 'cancelled')
  // 整体性的失败：不列逐类
  const gone = of({}, 'profile-gone')
  assert.equal(gone.overall, 'profile-gone')
  assert.equal(gone.say, 'bimport.overall.profileGone')
  assert.deepEqual(gone.kinds, [])
  assert.equal(of({}, 'busy').overall, 'busy')
  // 按固定的先后列，只列这次要导的和主进程报了的
  const two = reportOf(['passwords', 'cookies'], {
    kinds: { cookies: counts(), passwords: counts() },
  })
  assert.deepEqual(
    two.kinds.map((line) => line.kind),
    ['cookies', 'passwords'],
  )
  assert.deepEqual(
    reportOf(['passwords'], { kinds: { passwords: counts() } }).kinds.map((line) => line.kind),
    ['passwords'],
  )
})

test('主进程的回答先过一遍：拒绝时的 null、{}、[]，认不出的类别和数', () => {
  assert.equal(logic.parseOutcome(null), null)
  assert.equal(logic.parseOutcome({}), null)
  assert.equal(logic.parseOutcome('x'), null)
  assert.deepEqual(logic.parseOutcome({ error: 'busy' }), { error: 'busy', kinds: {} })
  assert.deepEqual(
    logic.parseOutcome({
      kinds: {
        cookies: {
          status: 'ok',
          discovered: 3,
          imported: 2.7,
          skippedExisting: -1,
          failed: 'x',
          error: 'e',
        },
        passwords: { status: 'weird' },
        history: { status: 'ok' },
      },
    }),
    {
      kinds: {
        cookies: {
          status: 'ok',
          discovered: 3,
          imported: 2,
          skippedExisting: 0,
          skippedInvalid: 0,
          failed: 0,
          error: 'e',
        },
      },
    },
  )
  assert.deepEqual(logic.parseSources(null), [])
  assert.deepEqual(logic.parseSources([chrome, { browser: 'x' }, null]), [chrome])
  assert.deepEqual(logic.parseState(null), {})
  assert.deepEqual(logic.parseState({ lastImportAt: 5, bannerDismissedAt: 'no' }), {
    lastImportAt: 5,
  })
})

test('重试：照原样能重试的几类，这一版导不了的不算；网站名单从最初的请求取；不提权', () => {
  const origin = {
    browser: 'edge',
    profileId: 'Default',
    kinds: ['cookies', 'passwords'],
    cookieDomains: ['github.com'],
    allowElevated: false,
  }
  const report = reportOf(origin.kinds, {
    kinds: {
      cookies: counts({ status: 'needs-elevation' }),
      passwords: counts({ status: 'locked' }),
    },
  })
  assert.deepEqual(retryRequest(origin, report), {
    browser: 'edge',
    profileId: 'Default',
    kinds: ['passwords'],
    allowElevated: false,
  })
  const locked = reportOf(origin.kinds, { kinds: { cookies: counts({ status: 'locked' }) } })
  assert.deepEqual(retryRequest({ ...origin, allowElevated: true }, locked), {
    browser: 'edge',
    profileId: 'Default',
    kinds: ['cookies', 'passwords'],
    cookieDomains: ['github.com'],
    allowElevated: false,
  })
  const onlyAppBound = reportOf(['cookies'], {
    kinds: { cookies: counts({ status: 'needs-elevation' }) },
  })
  assert.equal(retryRequest(origin, onlyAppBound), null)
  const fine = reportOf(['cookies'], { kinds: { cookies: counts() } })
  assert.equal(retryRequest(origin, fine), null)
})

test('重试的结果并进上一次的；整体性的失败以这一次为准', () => {
  const first = { kinds: { cookies: counts({ status: 'locked' }), passwords: counts() } }
  const merged = mergeOutcome(first, { kinds: { cookies: counts({ imported: 4 }) } })
  assert.equal(merged.kinds.cookies.imported, 4)
  assert.equal(merged.kinds.passwords.status, 'ok')
  assert.deepEqual(mergeOutcome(first, { error: 'busy', kinds: {} }), { error: 'busy', kinds: {} })
  assert.deepEqual(mergeOutcome(undefined, first), first)
})

test('对话框的阶段：找来源 → 选 → 导 → 结果 → 重试 → 结果；迟到的进度、不合阶段的事不理', () => {
  const request = {
    browser: 'chrome',
    profileId: 'Default',
    kinds: ['cookies', 'passwords'],
    allowElevated: false,
  }
  let step = { name: 'loading' }
  assert.equal(importStep(step, { type: 'start', request }), step)
  step = importStep(step, { type: 'loaded', sources: [edgeEmpty, chrome] })
  assert.equal(step.name, 'pick')
  assert.deepEqual(
    step.sources.map((one) => one.browser),
    ['chrome', 'edge'],
  )
  assert.equal(logic.canClose(step), true)
  step = importStep(step, { type: 'start', request })
  assert.equal(step.name, 'running')
  assert.equal(logic.canClose(step), false)
  step = importStep(step, { type: 'progress', progress: { kind: 'cookies', phase: 'reading' } })
  assert.equal(step.stages.cookies, 'reading')
  // 正在导的时候不重新找来源
  assert.equal(importStep(step, { type: 'load' }), step)
  step = importStep(step, { type: 'stop' })
  assert.equal(step.stopping, true)
  step = importStep(step, {
    type: 'finished',
    outcome: { kinds: { cookies: counts({ status: 'locked' }), passwords: counts() } },
  })
  assert.equal(step.name, 'done')
  assert.equal(step.origin, request)
  // 点过停止：结果页按停下了说
  assert.equal(step.stopped, true)
  assert.equal(reportOf(step.origin.kinds, step.outcome, step.stopped).overall, 'cancelled')
  const late = importStep(step, {
    type: 'progress',
    progress: { kind: 'cookies', phase: 'done' },
  })
  assert.equal(late, step)
  const retry = { ...request, kinds: ['cookies'] }
  step = importStep(step, { type: 'retry', request: retry })
  assert.equal(step.name, 'running')
  assert.deepEqual(step.stages, { cookies: 'waiting' })
  assert.equal(step.origin, request)
  step = importStep(step, { type: 'finished', outcome: { kinds: { cookies: counts() } } })
  // 重试没停：这一次按没停说
  assert.equal(step.stopped, false)
  assert.equal(reportOf(step.origin.kinds, step.outcome, step.stopped).overall, 'ok')
  // 回去重新选
  step = importStep(step, { type: 'back' })
  assert.equal(step.name, 'pick')
  // 开始不了（接口出错）
  step = importStep(step, { type: 'start', request })
  step = importStep(step, { type: 'startFailed', reason: 'x' })
  assert.deepEqual(step.name, 'startFailed')
  assert.equal(importStep(step, { type: 'back' }).name, 'pick')
  // 找来源失败、重新找
  let load = importStep({ name: 'loading' }, { type: 'loadFailed', reason: 'boom' })
  assert.deepEqual(load, { name: 'loadFailed', reason: 'boom' })
  load = importStep(load, { type: 'load' })
  assert.deepEqual(load, { name: 'loading' })
})

test('横幅：状态取到了、从没导过、没关过才出', () => {
  assert.equal(showBanner(null), false)
  assert.equal(showBanner({}), true)
  assert.equal(showBanner({ lastImportAt: 1 }), false)
  assert.equal(showBanner({ bannerDismissedAt: 1 }), false)
})

test('两种语言都有逻辑里用到的每一句，带名字的句子填得上', async () => {
  const { zhBimport } = await import('../src/i18n/zh-CN-bimport.ts')
  const { enBimport } = await import('../src/i18n/en-bimport.ts')
  assert.deepEqual(Object.keys(enBimport).sort(), Object.keys(zhBimport).sort())
  const used = [
    ...Object.values(logic.BLOCK_TEXT),
    ...Object.values(logic.LOOK_TEXT),
    ...Object.values(logic.PROBLEM_TEXT),
    ...Object.values(logic.STAGE_TEXT),
    ...Object.values(logic.OVERALL_TEXT),
    'bimport.status.ok',
    'bimport.status.okFailed',
    'bimport.status.empty',
    'bimport.status.partial',
    'bimport.status.missing',
    'bimport.status.locked',
    'bimport.status.denied',
    'bimport.status.needsElevation',
    'bimport.status.unsupported',
    'bimport.status.cancelled',
    'bimport.status.failed',
    'bimport.status.skipped',
  ]
  for (const key of used) assert.ok(key in zhBimport, key)
  for (const lang of ['zh-CN', 'en']) {
    const t = translator(lang)
    assert.match(t('bimport.status.locked', { name: 'Google Chrome' }), /Google Chrome/)
    assert.match(t('bimport.count.imported', { n: 12 }), /12/)
    assert.doesNotMatch(t('bimport.hint.close', { name: 'Firefox' }), /\{name\}/)
  }
})
