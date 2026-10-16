// 聚合面的扩展和 codex 原有类型拼在一起之后的形状，给客户端用。
// 设备进程不引用这个文件（它只解析方法名和会话标识，其余原样转发，不需要这些类型）。
import type {
  InitializeCapabilities,
  Thread,
  ThreadListParams,
  ThreadStartedNotification,
  ThreadStartParams,
} from './codex.mjs'
import type { LitchCapabilities, ThreadListSkippedHarness, WithHarness } from './device.mjs'

/** 握手时的 `capabilities`：codex 原有的，加上我们的扩展声明 */
export type DeviceInitializeCapabilities = InitializeCapabilities & LitchCapabilities

/**
 * 聚合面上的会话对象：多一个 `harness`，由路由按“这条记录从哪个上游来的”打上。
 * 上面的 `projectId`、`section`、`sectionEnteredAt` 是设备层的值（设备级的工作区与置顶，见 device.mts），
 * 不是引擎自己那一份；判断置顶看 `section?.id === PINNED_SECTION_ID`。
 */
export type HarnessThread = WithHarness<Thread>

/**
 * 聚合面上的 `thread/list`。只支持按更新时间倒序；`sortKey`、`sortDirection` 可以不带，带就只能是这两个值。
 * 带 `harness` 时只列这一个 harness 的（某个 harness 恢复可用之后补它那一份用）。
 * `projectId`、`sectionId` 由设备层来筛（不带是全部，null 是没有归属的、不在分区里的），不交给上游；
 * 其余筛选条件原样交给各个上游。
 */
export type DeviceThreadListParams = Omit<ThreadListParams, 'sortKey' | 'sortDirection'> & {
  sortKey?: 'updated_at' | null
  sortDirection?: 'desc' | null
  harness?: string | null
}

export interface DeviceThreadListResponse {
  data: HarnessThread[]
  /** 不透明的字符串，里面打包着各个上游的游标。只能原样交回来 */
  nextCursor: string | null
  /** 聚合面不支持反着翻页，一直是 null */
  backwardsCursor: null
  /** 这一次没有包含进来的 harness。没有就是空数组 */
  skippedHarnesses: ThreadListSkippedHarness[]
}

/** 聚合面上的 `thread/start`：必须带 `harness` 指明在哪个 harness 上新建 */
export type DeviceThreadStartParams = WithHarness<ThreadStartParams>

/** 聚合面上的 `thread/started`：里面的会话对象带 `harness` */
export type DeviceThreadStartedNotification = Omit<ThreadStartedNotification, 'thread'> & {
  thread: HarnessThread
}
