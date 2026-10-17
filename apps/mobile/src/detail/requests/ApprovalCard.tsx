// 审批：命令、文件改动、额外的权限、MCP 工具调用。有哪些按钮由请求自己带来（ApprovalOption），不按类型写死；
// “以后都允许”记下来的是什么（rule）写在按钮下面，点之前看得到。能带说明的“拒绝”多一个入口：
// 点开写一句为什么，随拒绝一起交给对面，模型看得到。
import type { ApprovalOption, ApprovalRequest } from '@litch/core'
import { Fragment, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { type Key, useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { Card, CardButton, type CardProps, Meta, useRespond, Well, Why } from './Card'

const OPTION_TEXT: Record<ApprovalOption['role'], Key> = {
  accept: 'request.option.accept',
  acceptSession: 'request.option.acceptSession',
  acceptAlways: 'request.option.acceptAlways',
  decline: 'request.option.decline',
  cancel: 'request.option.cancel',
}

const SUBJECT_TEXT: Record<ApprovalRequest['subject'], Key> = {
  command: 'request.command',
  fileChange: 'request.fileChange',
  permissions: 'request.permissions',
  tool: 'request.tool',
}

const KIND: Record<ApprovalOption['role'], 'primary' | 'plain' | 'danger' | 'ghost'> = {
  accept: 'primary',
  acceptSession: 'plain',
  acceptAlways: 'plain',
  decline: 'plain',
  cancel: 'danger',
}

export function ApprovalCard(props: CardProps<ApprovalRequest>) {
  const { request, waiting } = props
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const { busy, error, respond } = useRespond(props)
  const refuse = request.options.find((option) => option.role === 'decline')
  /** 正在写拒绝的说明时输入框里的字。null：没在写 */
  const [note, setNote] = useState<string | null>(null)
  const noting = note !== null && refuse?.note === true
  const { permissions, tool } = request
  const rules = request.options.filter((option) => option.rule)

  const declineWithNote = () => {
    const said = (note ?? '').trim()
    if (refuse && said) respond({ optionId: refuse.id, note: said })
  }

  const actions = noting ? (
    <>
      <CardButton
        kind="danger"
        testID="request:note-send"
        label={t('request.note.send')}
        disabled={busy || !(note ?? '').trim()}
        onPress={declineWithNote}
      />
      <CardButton
        kind="ghost"
        label={t('request.note.cancel')}
        disabled={busy}
        onPress={() => setNote(null)}
      />
    </>
  ) : (
    request.options.map((option) => (
      <Fragment key={option.id}>
        {option === refuse && option.note ? (
          <CardButton
            kind="ghost"
            testID="request:note-open"
            label={t('request.note.open')}
            disabled={busy}
            onPress={() => setNote('')}
          />
        ) : null}
        <CardButton
          kind={KIND[option.role]}
          testID={`request:option:${option.id}`}
          label={t(OPTION_TEXT[option.role])}
          disabled={busy}
          onPress={() => respond({ optionId: option.id })}
        />
      </Fragment>
    ))
  )

  return (
    <Card
      testID="request:approval"
      title={t(SUBJECT_TEXT[request.subject])}
      actions={actions}
      waiting={waiting}
      error={error}
    >
      {tool ? (
        <View style={styles.metas}>
          <Meta label={t('request.tool.server')} value={tool.server} />
          {tool.title ? <Meta label={t('request.tool.name')} value={tool.title} /> : null}
        </View>
      ) : null}
      {tool?.note ? <Why>{tool.note}</Why> : null}
      {tool?.params ? <Well>{tool.params}</Well> : null}
      {request.command ? <Well>{request.command}</Well> : null}
      {permissions ? (
        <View style={styles.metas}>
          {permissions.network ? <Why>{t('request.network')}</Why> : null}
          {permissions.read.length > 0 ? (
            <Meta label={t('request.read')} value={permissions.read.join('  ')} />
          ) : null}
          {permissions.write.length > 0 ? (
            <Meta label={t('request.write')} value={permissions.write.join('  ')} />
          ) : null}
        </View>
      ) : null}
      {request.cwd ? <Meta label={t('request.cwd')} value={request.cwd} /> : null}
      {request.reason ? <Why>{request.reason}</Why> : null}
      {rules.map((option) => (
        <View key={option.id} style={styles.rule}>
          <Text style={[styles.ruleHead, { color: c.ink3 }]}>
            {t(OPTION_TEXT[option.role])} · {t('request.rule')}
          </Text>
          <Text style={[styles.ruleText, { color: c.ink, fontFamily: theme.font.mono }]}>
            {option.rule}
          </Text>
        </View>
      ))}
      {noting ? (
        <TextInput
          autoFocus
          value={note ?? ''}
          onChangeText={setNote}
          placeholder={t('request.note.placeholder')}
          placeholderTextColor={c.ink3}
          accessibilityLabel={t('request.note.label')}
          editable={!busy}
          multiline
          testID="request:note"
          style={[
            styles.note,
            { color: c.ink, borderColor: c.line2, backgroundColor: c.panel, minHeight: theme.hit },
          ]}
        />
      ) : null}
    </Card>
  )
}

const styles = StyleSheet.create({
  metas: { gap: 4 },
  rule: { gap: 2 },
  ruleHead: { fontSize: 12 },
  ruleText: { fontSize: 12 },
  note: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
})
