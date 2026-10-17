// 一个文件的差异：合并的视图，一行一行用原生列表画（FlashList，只画看得见的行，几千行也不卡）。
// 长的行折行显示（手机上横着滑一整页代码不好读）。内容按需取（diff.file），概况换了一版就重新取。
// 太大的文件（增删超过 8000 行）不取内容，只说一句。
import type { DiffEntry, DiffScope, FileDiff } from '@litch/core'
import { FlashList } from '@shopify/flash-list'
import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Empty } from '../../../ui/kit/controls'
import { useTheme } from '../../../ui/theme'
import { reasonOf } from '../tool-errors'
import { changedLines, type DiffRow, FILE_LINES_MAX, rowsOf } from './rows'

export interface Where {
  deviceId: string
  root: string
  scope: DiffScope
  sessionId: string | null
}

type Loaded =
  | { state: 'loading' }
  | { state: 'ready'; file: FileDiff }
  | { state: 'failed'; reason: string }

export function FileDiffPane({
  where,
  entry,
  version,
}: {
  where: Where
  entry: DiffEntry
  /** 概况的版本：变了就重新取 */
  version: number
}) {
  const channel = useChannel()
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  const huge = changedLines(entry) > FILE_LINES_MAX
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const { deviceId, root, scope, sessionId } = where

  // biome-ignore lint/correctness/useExhaustiveDependencies: version 变了就是要重新取
  useEffect(() => {
    if (huge) return
    let stale = false
    setLoaded((before) => (before.state === 'ready' ? before : { state: 'loading' }))
    channel
      .command('diff.file', { deviceId, root, scope, sessionId, path: entry.path })
      .then((file) => {
        if (!stale) setLoaded({ state: 'ready', file })
      })
      .catch((error: unknown) => {
        if (!stale) setLoaded({ state: 'failed', reason: reasonOf(error, t) })
      })
    return () => {
      stale = true
    }
  }, [channel, deviceId, root, scope, sessionId, entry.path, version, huge, t])

  const file = loaded.state === 'ready' && loaded.file.path === entry.path ? loaded.file : null
  const rows = useMemo(() => (file?.kind === 'text' ? rowsOf(file) : []), [file])
  // 行号那一栏的宽：按最大的行号有几位算，整个文件一样宽，上下对齐
  const digits = useMemo(() => {
    let max = 1
    for (const hunk of file?.hunks ?? []) {
      max = Math.max(max, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines)
    }
    return String(max).length
  }, [file])

  if (huge) {
    return <Empty title={t('diffs.note.huge', { n: changedLines(entry), max: FILE_LINES_MAX })} />
  }
  if (loaded.state === 'failed')
    return <Empty title={t('diffs.failed', { reason: loaded.reason })} />
  if (!file) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={c.ink2} />
      </View>
    )
  }
  if (file.kind !== 'text' || rows.length === 0) {
    const note =
      file.kind === 'binary'
        ? t('diffs.note.binary')
        : file.kind === 'tooLarge'
          ? t('diffs.note.tooLarge')
          : file.kind === 'directory'
            ? t('diffs.note.directory')
            : file.kind === 'missing'
              ? t('diffs.note.missing')
              : entry.status === 'renamed'
                ? t('diffs.note.renamed')
                : entry.mode
                  ? t('diffs.note.mode')
                  : t('diffs.note.empty')
    return <Empty title={note} />
  }

  const notes = [
    file.noEolOld ? t('diffs.noEolOld') : null,
    file.noEolNew ? t('diffs.noEolNew') : null,
  ].filter((note): note is string => note !== null)

  return (
    <FlashList
      data={rows}
      keyExtractor={(row) => row.key}
      getItemType={(row) => row.kind}
      renderItem={({ item }) => <Line row={item} digits={digits} />}
      ListFooterComponent={
        notes.length > 0 ? (
          <Text style={[styles.foot, { color: c.ink3, fontSize: theme.font.size.small }]}>
            {notes.join('\n')}
          </Text>
        ) : null
      }
      testID="diff:lines"
    />
  )
}

function Line({ row, digits }: { row: DiffRow; digits: number }) {
  const theme = useTheme()
  const { c } = theme
  const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: 17 }
  if (row.kind === 'hunk') {
    return (
      <Text
        numberOfLines={1}
        style={[styles.hunk, mono, { color: c.ink3, backgroundColor: c.sunken }]}
      >
        {row.text}
      </Text>
    )
  }
  // 加的、删的行底色淡淡地染上状态色（#rrggbb 后面接透明度）
  const tint = row.sign === '+' ? `${c.ok}26` : row.sign === '-' ? `${c.err}26` : 'transparent'
  const ink = row.sign === '+' ? c.ok : row.sign === '-' ? c.err : c.ink3
  const number = (value: number | null) => (value === null ? '' : String(value)).padStart(digits)
  return (
    <View style={[styles.line, { backgroundColor: tint }]}>
      <Text style={[mono, { color: c.ink3 }]}>
        {number(row.old)} {number(row.next)}
      </Text>
      <Text style={[mono, styles.sign, { color: ink }]}>{row.sign}</Text>
      <Text style={[mono, styles.text, { color: c.ink }]}>{row.text}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hunk: { paddingHorizontal: 8, paddingVertical: 4 },
  line: { flexDirection: 'row', paddingHorizontal: 6 },
  sign: { width: 14, textAlign: 'center' },
  text: { flex: 1 },
  foot: { padding: 12 },
})
