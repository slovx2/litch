// 对话区里各个单元格共用的东西：这是哪个会话、认文件路径用的范围、点了链接和长按之后做什么。
// 值在一个会话里基本不变（范围在侧栏数据到了时变一次），单元格按行对象 memo，不会因为它频繁重画。
import {
  type DeviceView,
  type FileScope,
  keys,
  pathTwin,
  type SessionBackgroundView,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import { useFlashListContext } from '@shopify/flash-list'
import { createContext, useContext, useMemo } from 'react'
import type { Row } from '../core/rows'
import { useKey } from '../shell/services'
import { keepPlace } from './keep-place'

export interface TranscriptActions {
  deviceId: string
  sessionId: string
  /** 会话的 harness 叫什么（“Claude Code”）：回合在忙时那一句“{name} 正在工作”用 */
  harness: string
  /** 认文件路径的范围：工作区的根和会话的工作目录。还不知道时是 null，只认网址 */
  scope: FileScope | null
  /** 文件页开在哪个根下（工作区的主目录，不属于工作区的是会话的工作目录） */
  root: string | null
  toggle(key: string, turnId: string): void
  /** 点了链接：litch-file: 到文件页，http(s) 交给系统浏览器，别的不理 */
  openLink(url: string): void
  /** 长按一个回合里的东西。itemId 是被按的那条回答（复制它的全文），按的是别处时是 null */
  turnMenu(turnId: string): void
  /** 到“差异”页看这个会话工作目录里的改动 */
  openDiff(): void
  /** 到另一个会话（分叉来源） */
  openSession(sessionId: string): void
  /** 看大图 */
  viewImage(url: string): void
}

export const TranscriptContext = createContext<TranscriptActions | null>(null)

/**
 * 这个会话的后台任务（和输入框上方那一行同一份，background/BackgroundBar.tsx 的 useSessionBackground）：
 * 过程摘要数还有几个在后台跑、自发回合开头找叫醒它的任务。只有这两种单元格订阅它
 */
export const BackgroundContext = createContext<SessionBackgroundView | null>(null)

export function useBackgroundView(): SessionBackgroundView | null {
  return useContext(BackgroundContext)
}

export function useTranscript(): TranscriptActions {
  const value = useContext(TranscriptContext)
  if (!value) throw new Error('对话区的单元格要放在 TranscriptContext 里')
  return value
}

/**
 * 展开收起（一组过程、一步的细节、一段思考），被点的那一行原地不动、多出来的往下长（keep-place.ts）。
 * 拿不到列表（不在对话区的列表里）就照常展开收起
 */
export function useToggleInPlace(): (key: string, turnId: string) => void {
  const { toggle } = useTranscript()
  const list = useFlashListContext<Row>()
  return (key, turnId) => keepPlace(list?.getRef(), key, () => toggle(key, turnId))
}

/**
 * 这个会话认文件路径的范围。工作区的根从侧栏数据里取（会话属于哪个工作区、工作区有哪些目录），
 * 不属于工作区的会话以工作目录为根；路径的另一种写法按设备的系统认（macOS 的 /private/var 和 /var）
 */
export function useFileScope(
  deviceId: string,
  sessionId: string,
  cwd: string | null,
): { scope: FileScope | null; root: string | null } {
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workDir = cwd ?? summary?.cwd ?? null
  const workspaceId = summary?.workspaceId ?? null
  const os = device?.os ?? null
  return useMemo(() => {
    const workspace = workspaceId ? workspaces?.find((each) => each.id === workspaceId) : null
    const root = workspace?.roots[0] ?? workDir
    if (!root) return { scope: null, root: null }
    return { scope: { root, cwd: workDir ?? root, twin: pathTwin(os) }, root }
  }, [workspaces, workspaceId, workDir, os])
}
