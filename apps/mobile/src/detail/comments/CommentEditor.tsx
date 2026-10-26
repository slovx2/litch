// 写评论、改评论的对话框：上面是引用的那段（太长的可以在框里滚），下面一个多行输入框。
// 新加的（全文页选好一段之后）按钮是“加上”；改输入框上的评论片时是“保存”，另有“删掉”，能找到原文的还有“定位原文”。
import { useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { Dialog } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

export function CommentEditor({
  visible,
  index,
  quote,
  note,
  onSubmit,
  onRemove,
  onLocate,
  onClose,
}: {
  visible: boolean
  /** 改的是第几条（标题上写“评论 N”）。新加的是 null */
  index: number | null
  quote: string
  /** 打开时输入框里的字 */
  note: string
  onSubmit(note: string): void
  onRemove?(): void
  /** 滚到原文去。找不到原文时不给 */
  onLocate?(): void
  onClose(): void
}) {
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const [value, setValue] = useState(note)
  const input = useRef<TextInput>(null)
  // 新加的一打开就写：autoFocus 在安卓的对话框里只给光标不出键盘（那时对话框的窗口还没拿到焦点），
  // 对话框出来以后放掉焦点再拿一次
  const focus = () => {
    if (index !== null) return
    requestAnimationFrame(() => {
      input.current?.blur()
      input.current?.focus()
    })
  }
  useEffect(() => {
    if (visible) setValue(note)
  }, [visible, note])
  return (
    <Dialog visible={visible} onClose={onClose} onShow={focus}>
      <Text style={[styles.title, { color: c.ink }]}>
        {index === null ? t('comment.editor.new') : t('comment.ref', { n: index })}
      </Text>
      <ScrollView
        style={[styles.quoteBox, { borderLeftColor: c.line3, backgroundColor: c.sunken }]}
        nestedScrollEnabled
      >
        <Text style={[styles.quote, { color: c.ink2 }]} testID="comment-editor:quote">
          {quote}
        </Text>
      </ScrollView>
      <TextInput
        ref={input}
        autoFocus={index === null}
        value={value}
        onChangeText={setValue}
        placeholder={t('comment.editor.placeholder')}
        placeholderTextColor={c.ink3}
        multiline
        testID="comment-editor:note"
        style={[
          styles.input,
          {
            color: c.ink,
            borderColor: c.line2,
            backgroundColor: c.panel,
            borderRadius: theme.radius.m,
            minHeight: theme.hit,
          },
        ]}
      />
      <View style={styles.buttons}>
        {onLocate ? (
          <Button
            kind="plain"
            label={t('comment.locate')}
            testID="comment-editor:locate"
            onPress={() => {
              onClose()
              onLocate()
            }}
          />
        ) : null}
        {onRemove ? (
          <Button
            kind="danger"
            label={t('comment.editor.remove')}
            testID="comment-editor:remove"
            onPress={() => {
              onClose()
              onRemove()
            }}
          />
        ) : null}
        <View style={styles.grow} />
        <Button kind="plain" label={t('app.cancel')} onPress={onClose} />
        <Button
          label={t(index === null ? 'comment.editor.add' : 'comment.editor.save')}
          testID="comment-editor:ok"
          onPress={() => {
            // 先交上去再关：关掉在“回复”那里等于取消
            onSubmit(value.trim())
            onClose()
          }}
        />
      </View>
    </Dialog>
  )
}

const styles = StyleSheet.create({
  title: { fontSize: 17, fontWeight: '600' },
  quoteBox: { maxHeight: 132, borderLeftWidth: 2, paddingHorizontal: 10, paddingVertical: 6 },
  quote: { fontSize: 14, lineHeight: 20 },
  input: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
    maxHeight: 160,
    textAlignVertical: 'top',
  },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  grow: { flexGrow: 1 },
})
