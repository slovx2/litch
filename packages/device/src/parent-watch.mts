// 父进程没了就自己退出。
// 设备进程由常驻的 Go 进程拉起，自成一个进程组：Go 进程正常退出时会来收它，
// 但 Go 进程被强杀时没有人来收，它就成了孤儿，还占着聚合面的套接字。
// 这里没有别的可靠信号可用（标准输出是管道，但就绪之后设备进程不再往里写，对面关了也察觉不到），
// 所以定时看一眼父进程还在不在。

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // 没有权限发信号也说明进程在
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 启动时的父进程不在了就调用 onOrphan，只调用一次。
 * POSIX 上父进程一退出，子进程立刻被别的进程收养，父进程号会变；
 * Windows 上父进程号不变，要看那个进程还在不在。两样都看。
 */
export function watchParent(onOrphan: () => void, intervalMs = 1000): () => void {
  const parent = process.ppid
  // 启动时就已经没有父进程可看
  if (parent <= 1) return () => {}
  const timer = setInterval(() => {
    if (process.ppid === parent && alive(parent)) return
    clearInterval(timer)
    onOrphan()
  }, intervalMs)
  // 不因为这个定时器让进程一直活着
  timer.unref()
  return () => clearInterval(timer)
}
