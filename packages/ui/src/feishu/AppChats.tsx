// 应用详情 · 群：机器人所在的群（含机器人已不在、但还留着接入设置的群），每群一行：名字、外部群 / 已解散 /
// 机器人已不在群里的标记、接入状态。点未接入的群开接入对话框，点已接入的群开群设置；取消接入另有确认框。
// 刷新让设备先回源飞书；写操作带群的 revision，冲突时重读这一个群并提示重试。
import { useCallback, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { stamp } from '../app/format.ts'
import { Forward, Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { ChatDialog, ChatMarks } from './ChatDialog.tsx'
import { useFeishuChats, useFeishuRun } from './data.ts'
import { BotAvatar } from './FeishuSection.tsx'
import {
  chatAccessState,
  chatUnavailable,
  type FeishuChat,
  sortChats,
  type WriteBlock,
} from './model.ts'

export function AppChats({
  deviceId,
  appId,
  block,
}: {
  deviceId: string
  appId: string
  /** 写操作为什么不能做；null 是能做 */
  block: WriteBlock
}) {
  const t = useT()
  const { channel } = useServices()
  const view = useFeishuChats(deviceId, appId)
  const online = block !== 'offline'
  /** 命令结果或冲突后重读到的群：比快照新才用 */
  const [fresh, setFresh] = useState<Record<string, FeishuChat>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [unaccessing, setUnaccessing] = useState<string | null>(null)
  const [deleteRecords, setDeleteRecords] = useState(true)
  const act = useFeishuRun()
  const remember = useCallback(
    (chat: FeishuChat) => setFresh((all) => ({ ...all, [chat.chatId]: chat })),
    [],
  )
  const refetch = useCallback(
    (chatId: string) => {
      channel.command('feishu.chat.get', { deviceId, appId, chatId }).then(
        (result) => remember(result.chat),
        () => {},
      )
    },
    [channel, deviceId, appId, remember],
  )
  const unaccessAct = useFeishuRun(unaccessing ? () => refetch(unaccessing) : undefined)

  const listed = view?.value?.chats ?? null
  const chats = listed
    ? sortChats(
        listed.map((chat) => {
          const newer = fresh[chat.chatId]
          return newer && newer.revision > chat.revision ? newer : chat
        }),
      )
    : null
  const syncedAt = view?.value?.syncedAt ?? null
  const find = (chatId: string | null) => chats?.find((chat) => chat.chatId === chatId) ?? null
  const editingChat = find(editing)
  const unaccessChat = find(unaccessing)

  const refresh = () =>
    void act.run(() => channel.command('feishu.chat.list', { deviceId, appId, refresh: true }))
  const unaccess = async (chat: FeishuChat) => {
    setUnaccessing(null)
    const result = await unaccessAct.run(() =>
      channel.command('feishu.chat.unaccess', {
        deviceId,
        appId,
        chatId: chat.chatId,
        expectedRevision: chat.revision,
        deleteRecords,
      }),
    )
    if (result) remember(result.chat)
  }

  const error = view?.error ?? null
  return (
    <section className="ext-block" data-feishu-chats>
      <div className="ext-block-head">
        <h3>{t('feishu.chats.title')}</h3>
        <span className="grow" />
        <span className="ext-row-meta" data-feishu-synced>
          {syncedAt
            ? t('feishu.chats.syncedAt', { time: stamp(syncedAt * 1000, Date.now(), t.lang) })
            : t('feishu.chats.never')}
        </span>
        <button
          type="button"
          className="ibtn"
          data-act="feishu-chats-refresh"
          title={t('feishu.chats.refresh')}
          aria-label={t('feishu.chats.refresh')}
          disabled={!online || act.busy}
          onClick={refresh}
        >
          <Icon name="reload" small />
        </button>
      </div>
      <p className="fs-hint">{t('feishu.chats.note')}</p>
      {error ? (
        <div className="devp-note err" role="alert">
          {error.text ? t.text(error.text) : error.message}
        </div>
      ) : null}
      {act.error || unaccessAct.error ? (
        <div className="devp-note err" role="alert" data-feishu-chats-error>
          {act.error || unaccessAct.error}
        </div>
      ) : null}
      {chats === null ? (
        error ? null : (
          <div className="ext-empty">{t('feishu.loading')}</div>
        )
      ) : chats.length === 0 ? (
        <div className="ext-empty">{t('feishu.chats.none')}</div>
      ) : (
        <ul className="ext-list">
          {chats.map((chat) => {
            const state = chatAccessState(chat)
            const unavailable = chatUnavailable(chat)
            // 用不了的群不能新接入；已接入的照样能进设置
            const closed = state === 'none' && unavailable !== null
            return (
              <li key={chat.chatId}>
                <button
                  type="button"
                  className="ext-row fs-app-row fs-chat-row"
                  data-feishu-chat={chat.chatId}
                  data-access={state}
                  data-off={unavailable ?? undefined}
                  disabled={closed}
                  title={closed ? t(`feishu.chat.unavailable.${unavailable}`) : undefined}
                  onClick={() => setEditing(chat.chatId)}
                >
                  <BotAvatar app={{ name: chat.name, appId: chat.chatId }} />
                  <b className="ext-row-name ell">{chat.name || chat.chatId}</b>
                  <ChatMarks chat={chat} />
                  <span className="grow" />
                  <span className="ext-row-meta ell" data-tone={state === 'none' ? 'off' : 'ok'}>
                    {t(`feishu.chats.state.${state}`)}
                  </span>
                  <Forward />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {editingChat ? (
        <ChatDialog
          deviceId={deviceId}
          chat={editingChat}
          block={block}
          onChat={remember}
          onConflict={() => refetch(editingChat.chatId)}
          onUnaccess={() => {
            setEditing(null)
            setDeleteRecords(true)
            setUnaccessing(editingChat.chatId)
          }}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {unaccessChat ? (
        <Confirm
          title={t('feishu.chat.unaccess.title', {
            name: unaccessChat.name || unaccessChat.chatId,
          })}
          note={t('feishu.chat.unaccess.note')}
          yes={t('feishu.chat.unaccess')}
          no={t('feishu.cancel')}
          onYes={() => void unaccess(unaccessChat)}
          onClose={() => setUnaccessing(null)}
        >
          <label className="form-check">
            <input
              type="checkbox"
              data-feishu-delete-records
              checked={deleteRecords}
              onChange={(event) => setDeleteRecords(event.target.checked)}
            />
            {t('feishu.chat.unaccess.delete')}
          </label>
          {deleteRecords ? (
            <span className="fs-hint err">{t('feishu.chat.unaccess.deleteNote')}</span>
          ) : null}
        </Confirm>
      ) : null}
    </section>
  )
}
