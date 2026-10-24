// 离开详情设置之前先问（照桌面端 packages/ui/src/app/leave-guard.tsx）：配置、模型两个标签有没保存的改动时，
// 切标签、返回（标题栏的、系统的、手势）之前弹“保存 / 放弃 / 取消”。
// 改动所在的标签用 useLeaveGuard 登记，页面用 useLeave 拿到 leaveThen 和要画的对话框，标签包在 LeaveScope 里。
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useT } from '../../../ui/i18n'
import { Button } from '../../../ui/kit/controls'
import { Dialog } from '../../../ui/kit/overlays'
import { useTheme } from '../../../ui/theme'

/** 一块有没保存的改动：保存成了回 true（可以走了），没成回 false（留在原地，原因那一块自己显示） */
type Save = () => Promise<boolean>
type Guards = Set<{ current: Save }>

const GuardsContext = createContext<Guards>(new Set())

/** 登记一块的改动。dirty 为真时离开要先问；返回的 ref 里放“保存”（在渲染里随时换成最新的） */
export function useLeaveGuard(dirty: boolean) {
  const guards = useContext(GuardsContext)
  const save = useRef<Save>(async () => false)
  useEffect(() => {
    if (!dirty) return
    guards.add(save)
    return () => {
      guards.delete(save)
    }
  }, [dirty, guards])
  return save
}

/** 各个标签包在里面：它们登记的改动归这一页 */
export function LeaveScope({ guards, children }: { guards: Guards; children: ReactNode }) {
  return <GuardsContext.Provider value={guards}>{children}</GuardsContext.Provider>
}

/** 页面这一头：leaveThen 包住离开的动作；guards 交给 LeaveScope；dialog 画在页面里 */
export function useLeave() {
  const guards = useRef<Guards>(new Set()).current
  const [asking, setAsking] = useState<{ go(): void } | null>(null)
  const [saving, setSaving] = useState(false)
  const leaveThen = useCallback(
    (go: () => void) => {
      if (guards.size === 0) go()
      else setAsking({ go })
    },
    [guards],
  )
  const unsaved = useCallback(() => guards.size > 0, [guards])
  const settle = (how: 'save' | 'discard' | 'cancel') => {
    if (!asking || saving) return
    if (how === 'cancel') {
      setAsking(null)
      return
    }
    const done = () => {
      // 当作没有改动了，走的路上那一块卸掉时再注销
      guards.clear()
      setAsking(null)
      asking.go()
    }
    if (how === 'discard') {
      done()
      return
    }
    setSaving(true)
    void Promise.all([...guards].map((guard) => guard.current().catch(() => false))).then((all) => {
      setSaving(false)
      if (all.every(Boolean)) done()
      else setAsking(null)
    })
  }
  const dialog = (
    <LeaveDialog
      visible={asking !== null}
      saving={saving}
      onSave={() => settle('save')}
      onDiscard={() => settle('discard')}
      onCancel={() => settle('cancel')}
    />
  )
  return { leaveThen, unsaved, guards, dialog }
}

function LeaveDialog({
  visible,
  saving,
  onSave,
  onDiscard,
  onCancel,
}: {
  visible: boolean
  saving: boolean
  onSave(): void
  onDiscard(): void
  onCancel(): void
}) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  return (
    <Dialog visible={visible} onClose={onCancel}>
      <Text style={[styles.title, { color: c.ink, fontFamily: theme.font.ui }]}>
        {t('leave.title')}
      </Text>
      <Text style={[styles.detail, { color: c.ink2 }]}>{t('leave.note')}</Text>
      <View style={styles.buttons} testID="hc:leave">
        <Button
          kind="plain"
          label={t('leave.cancel')}
          disabled={saving}
          testID="hc:leave:cancel"
          onPress={onCancel}
        />
        <Button
          kind="danger"
          label={t('leave.discard')}
          disabled={saving}
          testID="hc:leave:discard"
          onPress={onDiscard}
        />
        <Button
          kind="solid"
          label={t(saving ? 'manage.saving' : 'leave.save')}
          busy={saving}
          testID="hc:leave:save"
          onPress={onSave}
        />
      </View>
    </Dialog>
  )
}

const styles = StyleSheet.create({
  title: { fontSize: 17, fontWeight: '600' },
  detail: { fontSize: 14, lineHeight: 20 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 10 },
})
