import ExpoModulesCore
import UIKit

public final class LitchKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LitchKeyboard")
    Function("show") { () -> Bool in
      // 页面由用户点击或公开 evaluateJavaScript 调用 focus。
      // 此处仅刷新已有第一响应者，不能用私有 WKContentView API 强制弹键盘。
      let show = {
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
          guard scene.activationState == .foregroundActive else { continue }
          for window in scene.windows where window.isKeyWindow {
            if let responder = self.firstResponder(in: window) {
              responder.reloadInputViews()
              return true
            }
          }
        }
        return false
      }
      return Thread.isMainThread ? show() : DispatchQueue.main.sync(execute: show)
    }
  }

  private func firstResponder(in view: UIView) -> UIView? {
    if view.isFirstResponder { return view }
    for child in view.subviews {
      if let responder = firstResponder(in: child) { return responder }
    }
    return nil
  }
}
