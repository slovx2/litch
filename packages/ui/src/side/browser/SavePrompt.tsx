// 浏览器面板上的“保存密码？”：这个会话里的标签（用户的、代理的都算）登录之后，外壳推来的保存提示。
// 画在 Litch 的界面里、网页上面那一条，不在网页里，网页和代理都看不到；没人点就一直挂着，不自动保存。
// 一次只出最新的一条，还有别的就写一句“还有几条”。提示里没有密码。
import { useEffect, useMemo, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { siteLabel } from '../../settings/tools-logic.ts'
import type { BrowserBridge, BrowserOwner, BrowserSaveAnswer, BrowserSavePrompt } from './bridge.ts'
import { promptsFor } from './save-prompt-logic.ts'
import './save-prompt.css'

export function SavePrompt({ bridge, owner }: { bridge: BrowserBridge; owner: BrowserOwner }) {
  const t = useT()
  const passwords = bridge.passwords
  const [all, setAll] = useState<BrowserSavePrompt[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    passwords.prompts().then(
      (list) => {
        if (live) setAll(list)
      },
      () => {},
    )
    const off = passwords.onPrompts((list) => setAll(list))
    return () => {
      live = false
      off()
    }
  }, [passwords])

  const mine = useMemo(() => promptsFor(all, owner), [all, owner])
  const prompt = mine[0]
  if (!prompt) return null

  const answer = (choice: BrowserSaveAnswer) => {
    setBusy(true)
    void passwords
      .answer(prompt.id, choice)
      .catch(() => false)
      .finally(() => setBusy(false))
  }
  const update = prompt.kind === 'update'
  const site = siteLabel(prompt.origin)
  return (
    <div className="bw-save" role="alert" data-save-prompt={prompt.kind}>
      <span className="bw-save-text">
        {prompt.username === ''
          ? t(update ? 'browser.save.updateNoUser' : 'browser.save.askNoUser', { site })
          : t(update ? 'browser.save.update' : 'browser.save.ask', {
              site,
              user: prompt.username,
            })}
        {mine.length > 1 ? (
          <span className="bw-save-more">{t('browser.save.more', { count: mine.length - 1 })}</span>
        ) : null}
      </span>
      <span className="bw-save-acts">
        <button
          type="button"
          className="btn"
          data-act="save-password"
          disabled={busy}
          onClick={() => answer('save')}
        >
          {t(update ? 'browser.save.updateYes' : 'browser.save.yes')}
        </button>
        <button
          type="button"
          className="btn ghost"
          data-act="skip-password"
          disabled={busy}
          onClick={() => answer('dismiss')}
        >
          {t(update ? 'browser.save.updateNo' : 'browser.save.no')}
        </button>
        <button
          type="button"
          className="btn ghost"
          data-act="never-password"
          disabled={busy}
          onClick={() => answer('never')}
        >
          {t('browser.save.never')}
        </button>
      </span>
    </div>
  )
}
