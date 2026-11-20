// 隐藏窗口中运行设备和收件箱的模拟验收。本脚本只写调用方指定的截图目录。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { runInPage } from './smoke.mjs'

const stages = [
  'owner',
  'device',
  'identityLogin',
  'identityOwner',
  'readiness',
  'repository',
  'manager',
  'inbox',
  'evidence',
  'decision',
  'triage',
] as const
type Stage = (typeof stages)[number]

async function pageStep(stage: Stage) {
  const one = <T extends HTMLElement = HTMLElement>(selector: string) =>
    document.querySelector<T>(selector)
  async function until<T>(what: string, read: () => T | false | null | undefined): Promise<T> {
    const end = Date.now() + 8000
    while (Date.now() < end) {
      const value = read()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    throw new Error(
      `${stage}: ${what}；${[...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent).join(' / ')}`,
    )
  }
  const at = (selector: string) => until(selector, () => one(selector))
  const click = async (selector: string) => {
    const button = await until(selector, () => {
      const el = one(selector)
      return el && !el.matches(':disabled') && el
    })
    button.click()
  }
  const named = async (scope: string, name: string) => {
    const button = await until(name, () =>
      [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find(
        (el) => !el.disabled && el.textContent?.trim() === name,
      ),
    )
    button.click()
  }
  const fill = async (selector: string, value: string) => {
    const field = await until(selector, () => one<HTMLInputElement>(selector))
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const select = async (selector: string, value: string) => {
    const field = await until(selector, () => one<HTMLSelectElement>(selector))
    field.value = value
    field.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const text = async (selector: string, value: string) =>
    until(value, () => one(selector)?.textContent?.includes(value))

  if (stage === 'owner') {
    await at('.sb-settings')
    const look = (window as unknown as { __litchLook: { set(value: object): void } }).__litchLook
    look.set({ lang: 'zh-CN', theme: 'light' })
    await click('.sb-settings')
    await click('.set-nav [data-section="external-account"]')
    await until('账号可读取', () => one('[data-external-owner] [type="submit"]:not(:disabled)'))
    await fill('[data-external-owner] input:not([type])', 'https://github.com/other-owner')
    await named('[data-external-owner]', '解析账号')
    await text('[data-external-owner]', '@other-owner')
    await named('[data-external-owner]', 'GitHub 数字 ID')
    await fill('[data-external-owner] input:not([type])', '9007199254740993')
    await named('[data-external-owner]', '解析账号')
    await text('[data-external-owner]', '9007199254740993')
    await named('[data-external-owner]', '使用本机 gh 登录账号')
    await named('[data-external-owner]', '解析账号')
    await named('[data-external-owner]', '确认并同步')
    await text('[data-external-owner]', '已同步')
    await until(
      '新同步结果',
      () =>
        ![...document.querySelectorAll('[data-external-owner] button')].some((el) =>
          el.textContent?.includes('确认并同步'),
        ),
    )
    await text('[data-external-owner]', '设备离线')
  }
  if (stage === 'device') {
    await click('[data-settings-device="local"]')
    await click('[data-sec="external-unattended"] .fold')
    await text('[data-external-identities]', '@sample-bot')
    await text('[data-sec="external-unattended"]', '即时反馈不可用')
    await text('[data-sec="external-unattended"]', 'Agent 正使用你的 GitHub 账号')
    await named('[data-sec="external-unattended"]', '启用自启')
    await text('dialog.external-dialog', '接管当前手动实例')
    await click('dialog.external-dialog input[type="checkbox"]')
    await named('dialog.external-dialog', '启用自启')
    await text('[data-sec="external-unattended"]', '已启用')
    const section = await at('[data-sec="external-unattended"]')
    ;(section.querySelector('h2') ?? section).scrollIntoView({
      block: 'start',
      behavior: 'instant',
    })
  }
  if (stage === 'identityLogin') {
    await named('[data-external-identities]', '授权机器人身份')
    const locked = [
      ...document.querySelectorAll<HTMLInputElement>(
        '[data-identity-auth] label input:checked:disabled',
      ),
    ]
    if (
      locked.map((field) => field.parentElement?.textContent?.trim()).join(',') !==
      'repo,read:org,gist'
    )
      throw new Error('基础 OAuth 权限未锁定')
    await text('[data-identity-auth]', '授权页显示的是 GitHub CLI')
  }
  if (stage === 'identityOwner') {
    await named('[data-identity-auth]', '导入设备上已登录的 gh 账号')
    await text('[data-identity-auth="succeeded"]', 'Sample Owner')
    await text('[data-identity-auth="succeeded"]', '确认使用我的账号')
    await text('[data-identity-auth="succeeded"]', 'sample-org/litch-demo')
  }
  if (stage === 'readiness') {
    await named('[data-identity-auth]', '取消')
    await until('已取消导入', () => !one('[data-identity-auth]'))
    const status = await at('[data-unattended-source]')
    await named('[data-unattended-source]', '暂停采集')
    await text('[data-unattended-source]', '已暂停')
    await named('[data-unattended-source]', '恢复采集')
    await text('[data-unattended-source]', '采集中')
    await click('[data-unattended-source] input[type="checkbox"]')
    await until('已启用自动提醒', () =>
      one<HTMLInputElement>('[data-unattended-source] input:checked'),
    )
    status.scrollIntoView({ block: 'start', behavior: 'instant' })
  }
  if (stage === 'repository') {
    await named('[data-sec="external-sources"]', '添加仓库')
    await at('dialog.external-dialog select option[value="20394868"]')
    await select('dialog.external-dialog select', '20394868')
    await fill('dialog.external-dialog input', '/work/empty-demo')
    await named('dialog.external-dialog', '下一步')
    await text('dialog.external-dialog', '最长延迟等于轮询间隔（120 秒）')
    await text('[data-route-preview]', '没有目标经理')
    await named('dialog.external-dialog', '下一步')
    await named('dialog.external-dialog', '预览近 24 小时')
    await text('[data-source-preview]', '近 24 小时没有匹配事件')
  }
  if (stage === 'manager') {
    await named('dialog.external-dialog', '保存来源')
    await text('[data-sec="external-sources"]', 'empty-demo')
    await select('[data-external-assignments] select', 'm3')
    await at('[data-external-assignment="m3"] select option[value="spare-bot"]')
    await select('[data-external-assignment="m3"] select', 'sample-bot')
    await text('[data-external-assignment="m3"]', '此身份已分配给该仓库的另一位经理')
    await select('[data-external-assignment="m3"] select', 'spare-bot')
    const option = await until('可接仓库', () =>
      [
        ...document.querySelectorAll<HTMLLabelElement>('[data-external-assignment="m3"] label'),
      ].find((el) => el.textContent?.includes('sample-org/litch-demo')),
    )
    option.querySelector<HTMLInputElement>('input')?.click()
    await named('[data-external-assignment="m3"]', '保存分配')
    await text('[data-external-assignment="m3"]', '请把机器人 @spare-bot 加进仓库')
    ;(await at('[data-external-assignments]')).scrollIntoView({ block: 'start' })
  }
  if (stage === 'inbox') {
    await click('.devp[data-detail="local"] .arch-head button:last-of-type')
    if (one('.set-page')) await click('.set-head .ibtn')
    await click('[data-sidebar-mode="manager"]')
    await click('[data-manager-id="m1"] [data-session] > button')
    await click('[data-inbox-tab="external"]')
    await text('[data-external-inbox]', 'litch-demo#108')
    await text('[data-external-inbox]', '提醒排队中')
    await named('[data-external-inbox]', '被挡下')
    await text('[data-external-inbox]', 'litch-demo#106')
    await named('[data-external-inbox]', '已处理')
    await text('[data-external-inbox]', 'litch-demo#107')
    await named('[data-external-inbox]', '待分拣')
    await text('[data-external-inbox]', 'litch-demo#108')
  }
  if (stage === 'evidence') {
    await named('[data-external-inbox]', '已处理')
    await named('[data-external-inbox]', 'X-1')
    await text('[data-external-evidence="X-1"]', '发起人 41623758')
    const refs = await at('[data-external-evidence="X-1"] a[href*="/issues/107"]')
    await click('[data-external-evidence="X-1"] summary')
    await text('[data-external-evidence="X-1"]', '发布收件回执')
    await at('[data-external-evidence="X-1"] a[href$="#issuecomment-2"]')
    refs.scrollIntoView({ block: 'center', behavior: 'instant' })
  }
  if (stage === 'decision') {
    window.dispatchEvent(
      new CustomEvent('litch-manager-issue', { detail: { managerId: 'm1', id: 'D-11' } }),
    )
    const result = await at('.mg-answer a[href$="#issuecomment-9012"]')
    if (result.textContent?.trim() !== '来自 GitHub 评论') throw new Error('缺 GitHub 评论来源')
    result.scrollIntoView({ block: 'center', behavior: 'instant' })
  }
  if (stage === 'triage') {
    await click('[data-inbox-tab="external"]')
    await named('[data-external-inbox]', '分拣')
    await named('dialog.external-dialog .seg', '忽略')
    await fill('dialog.external-dialog input', 'probe-only')
    await named('dialog.external-dialog .external-actions', '忽略')
    await text('[data-external-inbox]', '没有符合条件的记录')
  }
  await document.fonts.ready
  await new Promise<void>((ready) =>
    requestAnimationFrame(() => requestAnimationFrame(() => ready())),
  )
  return stage
}

export async function runExternalProbe(
  window: BrowserWindow,
): Promise<readonly [object, string[]]> {
  const directory = process.env.LITCH_EXTERNAL_SCREENSHOTS
  const passed: string[] = []
  if (directory) await mkdir(directory, { recursive: true })
  for (const stage of stages) {
    try {
      passed.push(await runInPage(window, pageStep, stage))
    } finally {
      if (directory) {
        const image = await window.webContents.capturePage(undefined, { stayHidden: true })
        if (!image.isEmpty()) await writeFile(join(directory, `${stage}.png`), image.toPNG())
      }
    }
  }
  return [{ passed, screenshots: directory ?? null }, []]
}
