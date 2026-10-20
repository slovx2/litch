// 评论的两层浮层，由详情页放一份：
// - 全文页：一条回答的全文放在一个能选字的输入框里（RN 的文字组件拿不到选区，输入框能），不弹键盘、改不动；
//   长按选好一段点“评论”，写评论后加到输入框上面（草稿，composer/drafts.ts）。
// - 看一条发出去的评论：卡片、回答里的 [N] 点出来的，引用全文和评论，能找到原文的可以滚过去。
import { MAX_COMMENTS } from '@litch/core'
import { useState } from 'react'
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputSelectionChangeEvent,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { Dialog } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { addDraftComment, loadDraftComments } from '../composer/drafts'
import { CommentEditor } from './CommentEditor'
import { useHubValue } from './context'
import type { CommentsHub } from './hub'

export function CommentOverlays({ hub }: { hub: CommentsHub }) {
  const picking = useHubValue(hub, (each) => each.picking, null)
  return (
    <>
      {/* 每次打开都是新的一份：全文、选区从头来 */}
      {picking ? <Picker key={picking} hub={hub} itemId={picking} /> : null}
      <Shown hub={hub} />
    </>
  )
}

interface Selection {
  start: number
  end: number
}

function Picker({ hub, itemId }: { hub: CommentsHub; itemId: string }) {
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const insets = useSafeAreaInsets()
  // 打开时的全文：回答还在流式也只拿这一刻的，选区不会因为字在长而挪位
  const [text] = useState(() => hub.store.itemText(itemId))
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 })
  const [quote, setQuote] = useState<string | null>(null)
  const close = () => hub.pick(null)
  const chosen = text ? text.slice(selection.start, selection.end).trim() : ''
  const full = loadDraftComments(hub.draftKey).length >= MAX_COMMENTS
  const onSelect = (event: TextInputSelectionChangeEvent) => {
    const { start, end } = event.nativeEvent.selection
    setSelection({ start: Math.min(start, end), end: Math.max(start, end) })
  }
  return (
    <Modal visible animationType="slide" onRequestClose={close}>
      <View
        style={[
          styles.page,
          { backgroundColor: c.raised, paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
        testID="comment-picker"
      >
        <View style={[styles.head, { borderBottomColor: c.line1, backgroundColor: c.panel }]}>
          <Text style={[styles.title, { color: c.ink }]}>{t('comment.pick.title')}</Text>
          <Button
            kind="plain"
            label={t('comment.close')}
            onPress={close}
            testID="comment-picker:close"
          />
        </View>
        <Text style={[styles.hint, { color: c.ink3 }]}>
          {text ? t('comment.pick.hint') : t('comment.pick.gone')}
        </Text>
        {text ? (
          <TextInput
            value={text}
            // 不弹键盘，也改不动：改了也会被受控的 value 还原（editable=false 在安卓上连选字都不让）
            showSoftInputOnFocus={false}
            multiline
            scrollEnabled
            autoCorrect={false}
            spellCheck={false}
            onSelectionChange={onSelect}
            testID="comment-picker:text"
            style={[styles.text, { color: c.ink, fontSize: theme.font.size.body }]}
          />
        ) : (
          <View style={styles.text} />
        )}
        <View style={[styles.bar, { borderTopColor: c.line1, backgroundColor: c.panel }]}>
          <Text style={[styles.count, { color: full ? c.err : c.ink2 }]} numberOfLines={2}>
            {full
              ? t('comment.full', { max: MAX_COMMENTS })
              : chosen
                ? t('comment.pick.selected', { n: chosen.length })
                : t('comment.pick.none')}
          </Text>
          <Button
            label={t('comment.add')}
            disabled={!chosen || full}
            testID="comment-picker:add"
            onPress={() => setQuote(chosen)}
          />
        </View>
      </View>
      <CommentEditor
        visible={quote !== null}
        index={null}
        quote={quote ?? ''}
        note=""
        onSubmit={(note) => {
          if (!quote) return
          // 满了的话按钮本来就按不了；加上了评论片出现在输入框上面，不另外说
          if (addDraftComment(hub.draftKey, { kind: 'comment', itemId, quote, note })) close()
        }}
        onClose={() => setQuote(null)}
      />
    </Modal>
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
  page: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: 1,
  },
  title: { fontSize: 17, fontWeight: '600' },
  hint: { fontSize: 13, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  text: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 8,
    lineHeight: 22,
    textAlignVertical: 'top',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: 1,
  },
  count: { flex: 1, fontSize: 13 },
  label: { fontSize: 12 },
  quoteBox: { maxHeight: 220, borderLeftWidth: 2, paddingHorizontal: 10, paddingVertical: 6 },
  quote: { fontSize: 14, lineHeight: 20 },
  note: { fontSize: 15, lineHeight: 22 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
})
