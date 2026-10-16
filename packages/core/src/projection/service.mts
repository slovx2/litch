// “设备服务是哪一份、这次换没换版本”到界面的投影（界面看到的形状在 model-service.mts）。
// 两个来处：对面在 runtime/info 的 device.service 里报的来历（协议扩展 deviceService），
// 和外壳连本机时记下的换版本结果（ServiceUpgradeReport）。
import type {
  DeviceServiceView,
  ServiceUpgradeReport,
  ServiceUpgradeView,
} from '../model-service.mjs'

/**
 * 对面报的来历 → 界面看到的。来历是对面发来的，不能只靠类型：
 * 版本、根目录、进程号、怎么起的，有一样不成样子就整个不要（宁可不说，也不说一半）；
 * 启动时间读不懂只是那一项不显示。程序文件的戳（build）界面用不着，不带过去
 */
export function projectService(given: unknown): DeviceServiceView | null {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return null
  const { pid, version, root, startedAt, detached } = given as Record<string, unknown>
  if (
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    typeof version !== 'string' ||
    version === '' ||
    typeof root !== 'string' ||
    typeof detached !== 'boolean'
  ) {
    return null
  }
  const at = typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN
  return { version, root, startedAt: Number.isFinite(at) ? at : null, detached, pid }
}

/**
 * 外壳记下的换版本结果 → 界面看到的。只挑界面用得着的：
 * 之前在跑的只留版本号（launched 时之前没有服务，不留）；忙的原因只在“因为忙没换”时带；
 * 启动参数、程序文件的戳不带。交出去的是新对象：通道上的增量是值，外壳之后再改它那一份不影响这边
 */
export function projectUpgrade(
  report: ServiceUpgradeReport | null | undefined,
): ServiceUpgradeView | null {
  if (!report) return null
  const kept = report.action === 'kept'
  return {
    action: report.action,
    bundled: { version: report.bundled.version, root: report.bundled.root },
    previous: report.action === 'launched' ? null : (report.running?.version ?? null),
    order: report.order,
    reason: kept ? report.reason : null,
    busy:
      kept && report.reason === 'busy'
        ? report.busy.map((entry) => ({
            reason: entry.reason,
            harnesses: [...entry.harnesses],
            count: entry.count,
          }))
        : [],
    detail: report.detail,
    pid: report.pid,
  }
}
