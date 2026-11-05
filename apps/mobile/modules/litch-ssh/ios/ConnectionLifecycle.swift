import Sshtransport
import UIKit

// 只把真正进入后台当作退后台；通知中心、系统登录弹层造成的失焦不算。
// iOS 不保证五分钟执行时间，系统到期先走同一 Go deadline，再结束后台任务。
final class ConnectionLifecycle: NSObject, SshtransportBackgroundSchedulerProtocol {
  private var notifications: [NSObjectProtocol] = []
  private var timer: DispatchWorkItem?
  private var task: UIBackgroundTaskIdentifier = .invalid
  private var epoch: Int64?

  func attach() {
    DispatchQueue.main.async { [self] in
      SshtransportSetBackgroundScheduler(self)
      let center = NotificationCenter.default
      notifications = [
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
          SshtransportSetAppBackground(true)
        },
        center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
          SshtransportSetAppBackground(false)
          // 状态查询会恢复被后台期限暂停的节点；不在主线程等待网络后端。
          DispatchQueue.global(qos: .utility).async { _ = try? TailscaleRuntime.shared.status() }
        },
      ]
      SshtransportSetAppBackground(UIApplication.shared.applicationState == .background)
    }
  }

  func detach() {
    DispatchQueue.main.async { [self] in
      notifications.forEach(NotificationCenter.default.removeObserver)
      notifications = []
      SshtransportSetAppBackground(false)
      SshtransportSetBackgroundScheduler(nil)
      cancelOnMain()
    }
  }

  func nowMillis() -> Int64 {
    // 单调时钟包含系统睡眠，不能用墙钟（用户改时间会改变期限）。
    Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) / 1_000_000)
  }

  func schedule(_ deadlineMillis: Int64, epoch: Int64) {
    // Go 持锁调用，必须排队，不能同步重入 BackgroundDeadline。
    DispatchQueue.main.async { [self] in
      cancelOnMain()
      self.epoch = epoch
      task = UIApplication.shared.beginBackgroundTask(withName: "LitchConnection") { [weak self] in
        self?.expire(epoch)
      }
      if task == .invalid {
        expire(epoch)
        return
      }
      let work = DispatchWorkItem { [weak self] in self?.expire(epoch) }
      timer = work
      let delay = Double(max(0, deadlineMillis - nowMillis())) / 1_000
      DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }
  }

  func cancel() { DispatchQueue.main.async { [self] in cancelOnMain() } }

  private func expire(_ expected: Int64) {
    guard epoch == expected else { return }
    SshtransportBackgroundDeadline(expected)
    cancelOnMain()
  }

  private func cancelOnMain() {
    epoch = nil
    timer?.cancel()
    timer = nil
    if task != .invalid {
      UIApplication.shared.endBackgroundTask(task)
      task = .invalid
    }
  }
}
