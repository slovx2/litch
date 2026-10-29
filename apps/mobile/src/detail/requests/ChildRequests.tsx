// 展开的子会话共用正式会话存储与请求卡片，不在父会话伪造答复消息。
import { keys, type SessionChildren, type SessionSummary } from '@litch/core'
import { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { delegatedResponseText } from '../../../../../packages/ui/src/composer/delegated-response'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { useSessionStore } from '../proposals/hooks'
import { RequestSlot } from './RequestSlot'

export function ChildRequests({
  deviceId,
  sessionId,
  onOpen,
}: {
  deviceId: string
  sessionId: string
  onOpen(id: string): void
}) {
  const children = useKey<SessionChildren>(keys.children(deviceId))?.[sessionId] ?? []
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <View>
      {children.map((id) => (
        <Child
          key={id}
          deviceId={deviceId}
          id={id}
          open={selected === id}
          toggle={() => setSelected(selected === id ? null : id)}
          onOpen={onOpen}
        />
      ))}
    </View>
  )
}

function Child({
  deviceId,
  id,
  open,
  toggle,
  onOpen,
}: {
  deviceId: string
  id: string
  open: boolean
  toggle(): void
  onOpen(id: string): void
}) {
  const child = useKey<SessionSummary>(keys.summary(deviceId, id))
  const t = useT()
  const { c, font } = useTheme()
  if (!child?.pendingRequests?.length) return null
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        style={{ padding: 8 }}
      >
        <Text numberOfLines={1} style={{ color: c.wait, fontSize: font.size.meta }}>
          {open ? '⌄' : '›'} {t('ask.children')} · {t.text(child.title)} · {child.harness} ·{' '}
          {child.pendingRequests[0]?.title}
        </Text>
      </Pressable>
      {open ? (
        <>
          <Pressable accessibilityRole="button" onPress={() => onOpen(id)} style={{ padding: 8 }}>
            <Text style={{ color: c.accent }}>{t('tree.child.open')}</Text>
          </Pressable>
          <OpenChild deviceId={deviceId} sessionId={id} />
        </>
      ) : null}
    </View>
  )
}

function OpenChild({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const store = useSessionStore(deviceId, sessionId)
  return <RequestSlot store={store} maxHeight={280} onRevise={() => {}} requestsOnly />
}

export function DelegatedHistory({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const { c, font } = useTheme()
  const [open, setOpen] = useState(false)
  const records =
    useKey<SessionSummary>(keys.summary(deviceId, sessionId))?.delegatedResponses ?? []
  if (!records.length) return null
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ padding: 8 }}
      >
        <Text style={{ color: c.ink2, fontSize: font.size.meta }}>
          {open ? '⌄' : '›'} {t('ask.delegatedHistory', { count: records.length })}
        </Text>
      </Pressable>
      {open ? (
        <ScrollView style={{ maxHeight: 200 }}>
          {records.map((record) => (
            <View key={record.id} style={{ padding: 8 }}>
              <Text style={{ color: c.ink, fontSize: font.size.meta }}>
                {t(record.parent ? 'ask.delegatedParent' : 'ask.delegatedSession', {
                  name: record.sourceTitle || record.sourceThreadId,
                })}
              </Text>
              <Text selectable style={{ color: c.ink2, fontSize: font.size.meta }}>
                {new Date(record.at).toLocaleString()}
                {'\n'}
                {delegatedResponseText(record, t)}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  )
}
