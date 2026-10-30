import { keys, managerMark, type SessionSummary } from '@litch/core'
import { useEffect, useRef } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import type { Selection } from './App.tsx'
import { useKey } from './services.tsx'

/** 隐藏视图也订阅摘要，归档、删除后立即忘记；首次摘要尚未到达时不误清。 */
export function useSelectionLifetime(
  selection: Selection | null,
  managers: ManagerView[],
  onMissing: (selection: Selection) => void,
) {
  const summary = useKey<SessionSummary>(
    keys.summary(selection?.deviceId ?? '', selection?.sessionId ?? ''),
  )
  const seen = useRef<Selection | null>(null)
  const seenManager = useRef<Selection | null>(null)
  useEffect(() => {
    if (!selection) return
    if (summary) seen.current = selection
    else if (seen.current === selection) {
      onMissing(selection)
      return
    }
    const mark = summary ? managerMark(summary) : null
    const manager = managers.find(
      (entry) =>
        entry.deviceId === selection.deviceId &&
        (entry.threadId === selection.sessionId || entry.id === mark?.managerId),
    )
    if (manager) seenManager.current = selection
    else if (seenManager.current === selection) onMissing(selection)
  }, [selection, summary, managers, onMissing])
}
