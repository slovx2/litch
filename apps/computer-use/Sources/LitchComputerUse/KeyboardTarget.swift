// 保存面板的 AX 代理属于宿主应用，接收键盘的远程控件却可能属于 ViewBridge 服务。
// 只从目标应用当前焦点解析实际 PID，不按进程名搜索，不把输入广播到系统前台。
import ApplicationServices
import Darwin
import LitchComputerUseCore

enum KeyboardTarget {
  private typealias ActualPID = @convention(c) (AXUIElement, UnsafeMutablePointer<pid_t>) -> AXError
  private static let actualPID: ActualPID? = {
    guard let library = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY),
      let symbol = dlsym(library, "_AXUIElementGetActualPid") else { return nil }
    return unsafeBitCast(symbol, to: ActualPID.self)
  }()

  static func resolve(appPID: pid_t) throws -> pid_t {
    try resolve(appPID: appPID, focus: {
      AXReader.copy(AXReader.appElement(appPID), kAXFocusedUIElementAttribute as String)
    }, actual: { element in
      var pid: pid_t = 0
      guard let actualPID, actualPID(element, &pid) == .success else { return nil }
      return pid
    })
  }

  /// 注入读取函数供单测使用；没有焦点的空白应用仍可由宿主菜单接收 cmd+n。
  static func resolve(appPID: pid_t, focus: () -> AXUIElement?,
    actual: (AXUIElement) -> pid_t?) throws -> pid_t {
    guard let element = focus() else { return appPID }
    guard let pid = actual(element), pid > 0 else {
      throw RPCError(.failed, "Could not resolve the focused control's keyboard process; no input was sent. Call get_app_state before retrying.")
    }
    return pid
  }
}
