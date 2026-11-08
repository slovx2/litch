// 只编入隔离探针：存活期间保护自身 .app，构建器不能覆盖正在使用的产物。
import Darwin
import Foundation

func holdProbeLease(appPath: String = Bundle.main.bundlePath) -> Int32 {
  let path = URL(fileURLWithPath: appPath).resolvingSymlinksInPath().path + ".lock"
  let descriptor = open(path, O_RDONLY | O_CREAT, mode_t(0o600))
  guard descriptor >= 0, flock(descriptor, LOCK_SH | LOCK_NB) == 0 else {
    fputs("探针正在构建，停止启动；请构建完成后重试。\n", stderr)
    exit(75)
  }
  // 不提前 close：退出或崩溃时由内核释放，父驱动先退出也不会失去运行保护。
  return descriptor
}
