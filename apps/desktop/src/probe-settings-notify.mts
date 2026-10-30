// 隐藏窗口里检查通知范围：两档选择、即时保存、重载与冷启动保留；截图沿用设置验收的出口。
import type { SettingsKit } from './probe-settings-kit.mjs'

export async function notifyScopeSeen(expected: 'all' | 'main', exercise = false): Promise<void> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  await kit.openSettings('notify')
  const selected = () => kit.one('[data-choice="notifyScope"] [aria-pressed="true"]')?.dataset.value
  await kit.until(`通知范围为 ${expected}`, () => selected() === expected)
  if (exercise) {
    for (const value of ['main', 'all', 'main']) {
      kit.one<HTMLButtonElement>(`[data-choice="notifyScope"] [data-value="${value}"]`)?.click()
      await kit.until(
        `通知范围 ${value} 已保存`,
        () => selected() === value && localStorage.getItem('litch.notify.scope') === value,
      )
    }
    if (kit.one('[data-act="notify-sessions"]')?.getAttribute('aria-checked') !== 'true')
      throw new Error('改变范围不应关闭会话通知总开关')
  }
  const en = kit.look.get().lang === 'en'
  const labels = kit.all('[data-choice="notifyScope"] button').map((button) => kit.text(button))
  const wanted = en ? ['All conversations', 'Main sessions only'] : ['全部对话', '仅主会话']
  if (JSON.stringify(labels) !== JSON.stringify(wanted))
    throw new Error(`通知范围文案不符：${JSON.stringify(labels)}`)
  await kit.settled()
  const audit = kit.audit('.set-content')
  if (audit.overflow.length || audit.unreadable.length)
    throw new Error(`通知设置排版异常：${JSON.stringify(audit)}`)
}
