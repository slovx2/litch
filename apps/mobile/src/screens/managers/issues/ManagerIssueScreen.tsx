// 经理 issue 的完整讨论页：和半屏抽屉同一套讨论界面（IssueThread），整页滚动，输入框在页尾。
// 特殊 issue 把原来的快速处理卡放在原帖位置，评论不代替快速处理。
import {
  keys,
  type ManagerBoardTopicView,
  type ManagerObjectId,
  type ManagerView,
  type SuggestionView,
} from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { RootStackParamList } from '../../../nav/routes'
import { useChannel, useKey, useReplica } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Empty } from '../../../ui/kit/controls'
import { KeyboardFormScrollView } from '../../../ui/kit/KeyboardForm'
import { Screen } from '../../../ui/kit/Screen'
import { useTheme } from '../../../ui/theme'
import { Issue } from '../Issue'
import { IssueContext } from '../IssueRelations'
import { useIssueCommands, useManagerIssues } from './data'
import { IssueComposer, IssueMetaLine, IssueThread } from './IssueThread'

type Props = NativeStackScreenProps<RootStackParamList, 'ManagerIssue'>

export function ManagerIssueScreen({ route, navigation }: Props) {
  const { deviceId, managerId, id } = route.params
  const t = useT()
  const { c, font } = useTheme()
  const replica = useReplica()
  const channel = useChannel()
  useEffect(() => replica.openManagerBoard(deviceId, managerId), [replica, deviceId, managerId])
  const manager = useKey<ManagerView>(keys.manager(deviceId, managerId))
  const view = useKey<ManagerBoardTopicView>(keys.managerBoard(deviceId, managerId))
  const suggestions = useKey<readonly SuggestionView[]>(keys.suggestions) ?? []
  const device = useKey<{ connection?: string }>(keys.device(deviceId))
  const board = view?.board ?? null
  const issues = useManagerIssues(view)
  const commands = useIssueCommands({ deviceId, id: managerId }, issues.discussions === true)
  const issue = issues.details[id as keyof typeof issues.details]
  const [readError, setReadError] = useState('')
  useEffect(() => {
    let current = true
    setReadError('')
    void commands.read(id).catch((error) => {
      if (current) setReadError(String(error))
    })
    return () => {
      current = false
    }
  }, [commands, id])
  const paged = Boolean(view?.paging)
  const detailId = issue && issue.kind !== 'ordinary' ? issue.id : undefined
  useEffect(() => {
    if (!paged || !detailId) return
    void channel
      .command('managers.board.detail', { deviceId, managerId, id: detailId as ManagerObjectId })
      .catch(() => {})
  }, [channel, deviceId, managerId, paged, detailId])
  const offline = device?.connection !== 'online'
  const disabled = offline || manager?.status !== 'active'
  const reason = t(offline ? 'issue.offline' : 'issue.readOnly')
  const openItem = (item: string) =>
    navigation.navigate('ManagerConsole', { deviceId, managerId, issue: item })
  if (!issue || !manager)
    return (
      <Screen title={t('issue.full.title')} testID="manager-issue">
        <Empty busy={!readError} title={readError || t('manager.loading')} />
      </Screen>
    )
  const post = board?.posts?.find((one) => one.id === (issue.id as string))
  const quick =
    issue.kind !== 'ordinary' && board && post && view ? (
      <IssueContext.Provider value={{ manager, board, features: view.features, open: openItem }}>
        <Issue
          manager={manager}
          post={post}
          board={board}
          suggestions={suggestions}
          talking={false}
          onTalk={() => {}}
          onBack={() => {}}
          onPosition={() => {}}
          bare
          inline
          hideDiscussion
        />
      </IssueContext.Provider>
    ) : undefined
  return (
    <Screen title={`${issue.id} · ${t('issue.full.title')}`} testID="manager-issue">
      <KeyboardFormScrollView testID="manager-issue-scroll" style={styles.fill}>
        <View style={styles.body}>
          <Text style={{ color: c.ink, fontSize: font.size.title + 1, fontWeight: '600' }}>
            {issue.title}
          </Text>
          <IssueMetaLine
            withKind
            head={{
              ...issue,
              author: issue.author.kind,
              followUp: issue.followUp.state,
              preview: '',
            }}
            comments={issue.discussion.comments.length}
          />
          {offline ? (
            <Text testID="issue-offline" style={{ color: c.wait, fontSize: font.size.meta }}>
              {t('issue.offline')}
            </Text>
          ) : null}
          <IssueThread
            key={issue.id}
            changes={board?.changes ?? []}
            manager={manager}
            issue={issue}
            disabled={disabled}
            reason={reason}
            commands={commands}
            quick={quick}
            onOpenItem={openItem}
          />
          <IssueComposer
            manager={manager}
            issue={issue}
            disabled={disabled}
            reason={reason}
            commands={commands}
          />
        </View>
      </KeyboardFormScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 16, gap: 12 },
})
