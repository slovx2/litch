package dev.litch.keyboard

import android.content.Context
import android.view.inputmethod.InputMethodManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// 安卓的 WebView 里，页面自己 focus() 一个输入框只有在用户手势里才会弹软键盘；终端页的 ⌨ 键是原生按钮，
// 不算 WebView 里的手势。这里在页面拿到焦点之后，直接请系统输入法给拿着焦点的视图弹出键盘
class LitchKeyboardModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LitchKeyboard")

    /** 给眼下拿着焦点的视图弹出软键盘；没有拿着焦点的视图就什么都不做，返回 false */
    Function("show") {
      val activity = appContext.currentActivity ?: return@Function false
      val view = activity.currentFocus ?: return@Function false
      view.post {
        val manager = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        manager.showSoftInput(view, InputMethodManager.SHOW_IMPLICIT)
      }
      true
    }
  }
}
