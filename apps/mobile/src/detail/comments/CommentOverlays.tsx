// 评论浮层，由详情页放一份；选字始终在原消息上进行，不另开全文页。
// - 选字后点“回复”：写评论的对话框，“加上”后加到输入框上面。
// - 看一条发出去的评论：卡片、回答里的 [N] 点出来的，引用全文和评论，能找到原文的可以滚过去。
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { requestCommentFocus } from '../../../../../packages/ui/src/composer/comment-focus'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { Dialog } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { CommentEditor } from './CommentEditor'
import { useHubValue } from './context'
import type { CommentsHub } from './hub'

export function CommentOverlays({ hub }: { hub: CommentsHub }) {
  return (
    <>
      <Replying hub={hub} />
      <Shown hub={hub} />
    </>
  )
}

/** 选字后点了“回复”：给选中的那段写评论（可以不写），输入框一打开就拿着焦点 */
function Replying({ hub }: { hub: CommentsHub }) {
  const replying = useHubValue(hub, (each) => each.replying, null)
  return (
    <CommentEditor
      visible={replying !== null}
      index={null}
      quote={replying?.quote ?? ''}
      note=""
      onSubmit={(note) => hub.replied(note)}
      onSaved={() => requestCommentFocus(hub.draftKey)}
      onClose={() => hub.replying && hub.replied(null)}
    />
  )
}

/** 点卡片、回答里的 [N] 弹出来的：引用全文、评论，能找到原文的有“定位原文” */
function Shown({ hub }: { hub: CommentsHub }) {
  const { c, font } = useTheme()
  const t = useT()
  const shown = useHubValue(hub, (each) => each.shown, null)
  const close = () => hub.show(null)
  const target = shown ? { quote: shown.comment.quote, turnId: shown.turnId } : null
  const located = target ? hub.locate(target) !== null : false
  return (
    <Dialog visible={shown !== null} onClose={close}>
      {shown ? (
        <>
          <Text style={[styles.label, { color: c.ink3, fontFamily: font.mono }]}>
            {t('comment.ref', { n: shown.comment.index })}
          </Text>
          <ScrollView
            style={[styles.quoteBox, { borderLeftColor: c.line3, backgroundColor: c.sunken }]}
            nestedScrollEnabled
          >
            <Text style={[styles.quote, { color: c.ink2 }]} testID="comment-shown:quote">
              {shown.comment.quote}
            </Text>
          </ScrollView>
          <Text
            style={[styles.note, { color: shown.comment.note ? c.ink : c.ink3 }]}
            testID="comment-shown:note"
          >
            {shown.comment.note || t('comment.noNote')}
          </Text>
          {located ? null : (
            <Text style={[styles.label, { color: c.ink3 }]}>{t('comment.notFound')}</Text>
          )}
          <View style={styles.buttons}>
            {located && target ? (
              <Button
                kind="plain"
                label={t('comment.locate')}
                testID="comment-shown:locate"
                onPress={() => {
                  close()
                  hub.jump(target)
                }}
              />
            ) : null}
            <Button label={t('comment.close')} testID="comment-shown:close" onPress={close} />
          </View>
        </>
      ) : null}
    </Dialog>
  )
}

const styles = StyleSheet.create({
  label: { fontSize: 12 },
  quoteBox: { maxHeight: 220, borderLeftWidth: 2, paddingHorizontal: 10, paddingVertical: 6 },
  quote: { fontSize: 14, lineHeight: 20 },
  note: { fontSize: 15, lineHeight: 22 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
})
