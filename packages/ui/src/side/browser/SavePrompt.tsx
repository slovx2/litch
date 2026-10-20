// 浏览器面板上的“保存密码？”：这个会话里的标签（用户的、代理的都算）登录之后，外壳推来的保存提示。
// 画在 Litch 的界面里、网页上面那一条，不在网页里，网页和代理都看不到；没人点就挂着（标签关了外壳一起丢），不自动保存。
// 系统钥匙串不可用时外壳推的是 unavailable：说明存不了、为什么，只能关掉。写库失败时提示留着，在这一条里说原因。
// 一次只出最新的一条，还有别的就写一句“还有几条”。提示里没有密码。
import { useEffect, useMemo, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { reasonOf } from '../../app/errors.ts'
import { siteLabel } from '../../settings/tools-logic.ts'
import type { BrowserBridge, BrowserOwner, BrowserSaveAnswer, BrowserSavePrompt } from './bridge.ts'
import { promptsFor } from './save-prompt-logic.ts'
import './save-prompt.css'

export function SavePrompt({ bridge, owner }: { bridge: BrowserBridge; owner: BrowserOwner }) {
  const t = useT()
  const passwords = bridge.passwords
  const [all, setAll] = useState<BrowserSavePrompt[]>([])
  const [busy, setBusy] = useState(false)
  /** 上一次答的没做成（写库失败），提示还留着 */
  const [failure, setFailure] = useState<string | null>(null)

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
  // 换了一条提示，上一条的错误不留
  const promptId = prompt?.id
  useEffect(() => {
    if (promptId !== undefined) setFailure(null)
  }, [promptId])
  if (!prompt) return null

  const answer = (choice: BrowserSaveAnswer) => {
    setBusy(true)
    setFailure(null)
    void passwords
      .answer(prompt.id, choice)
      .then(
        () => {},
        (error: unknown) =>
          setFailure(
            (error as { code?: unknown } | null)?.code === 'file-unavailable'
              ? t('browser.save.fileFailed')
              : t('browser.save.failed', { reason: reasonOf(error, t) }),
          ),
      )
      .finally(() => setBusy(false))
  }
  const site = siteLabel(prompt.origin)
  const more =
    mine.length > 1 ? (
      <span className="bw-save-more">{t('browser.save.more', { count: mine.length - 1 })}</span>
    ) : null
  if (prompt.kind === 'unavailable') {
    // 钥匙串不可用：存不了，告诉人为什么，只能关掉
    return (
      <div className="bw-save" role="alert" data-save-prompt="unavailable">
        <span className="bw-save-text">
          {t('browser.save.unavailable', { site, user: prompt.username })}
          {more}
        </span>
        <span className="bw-save-acts">
          <button
            type="button"
            className="btn ghost"
            data-act="skip-password"
            disabled={busy}
            onClick={() => answer('dismiss')}
          >
            {t('browser.save.close')}
          </button>
        </span>
      </div>
    )
  }
  const update = prompt.kind === 'update'
  return (
    <div className="bw-save" role="alert" data-save-prompt={prompt.kind}>
      <span className="bw-save-text">
        {t(update ? 'browser.save.update' : 'browser.save.ask', { site, user: prompt.username })}
        {more}
        {failure ? (
          <span className="bw-save-err" data-save-error>
            {failure}
          </span>
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
