// 常驻服务报自己是哪一份（扩展名 deviceService）：聚合面的 `runtime/info` 在 `device.service` 里给出
// 这台设备上正在运行的那份适配器服务的版本、它是从哪份适配器起的、什么时候起的、怎么起的。
// 这里的东西都不是 codex 原有的。定义的原文在仓库根目录 protocol/extensions/device-service.json，
// 规矩见设计文档 03 第十五节。
//
// 为什么要有它：服务一旦起来，跑的就一直是起它那一刻的那份程序；应用升级了、另外装了新版，后台的还是旧的。
// 客户端要看得到“对面到底是哪一份”，才说得出“服务比应用旧，等它闲下来换掉”这样的话。
// 能用什么仍然只看 `device.extensions`，不拿这里的版本号去猜功能。
//
// 这个文件自成一体，不引用任何别的文件：设备进程（packages/device）和客户端核心（packages/core）都直接引用它。

/** 正在运行的那份适配器常驻服务的来历。服务启动时定下来，之后不变 */
export interface DeviceServiceInfo {
  /** 常驻进程的进程号 */
  pid: number
  /**
   * 服务的版本，和那份适配器的 `codex-harness-adapter version` 报的是同一个。
   * 拿不到版本号的构建报的是 `0.0.0-unknown`
   */
  version: string
  /** 它是从哪份适配器起的：那份适配器的根目录，设备上的绝对路径 */
  root: string
  /** 什么时候起的，RFC 3339，UTC */
  startedAt: string
  /**
   * true：由 `device-start` 按需拉起、脱离出去的，没有别的东西管着它的生死。
   * false：在前台运行，或者由服务管理器（brew services、systemd）启动的
   */
  detached: boolean
  /**
   * 那份适配器的程序文件的戳（修改时间和大小），不透明，只用来比是不是同一个。
   * 版本号相同的两份构建靠它分辨；只在 `root` 相同的时候有意义。取不到时没有这个字段
   */
  build?: string
}
