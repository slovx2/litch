package dev.litch.keyboard

import android.content.Context
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

// 不处理 IME 的软键盘事件和组合文本；Shift+Enter 原样交给多行输入框。
class HardwareKeyboardView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  val onSubmit by EventDispatcher()
  var submitEnabled = false
  private var submitOnRelease = false

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.keyCode != KeyEvent.KEYCODE_ENTER) return super.dispatchKeyEvent(event)
    val input = findFocus() as? EditText
    if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
      // 在按下时记住组合键；松开 Shift 再松开 Enter 不能误发送刚输入的换行。
      submitOnRelease = submitEnabled && input != null &&
        !event.isShiftPressed && !event.isCtrlPressed && !event.isAltPressed && !event.isMetaPressed &&
        event.flags and KeyEvent.FLAG_SOFT_KEYBOARD == 0 &&
        BaseInputConnection.getComposingSpanStart(input.text) == -1
    }
    if (event.action == KeyEvent.ACTION_UP && submitOnRelease) {
      submitOnRelease = false
      if (submitEnabled && input != null && !event.isCanceled) onSubmit(emptyMap<String, Any>())
      return true
    }
    if (submitOnRelease) return true
    return super.dispatchKeyEvent(event)
  }

  override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
    if (!hasWindowFocus) submitOnRelease = false
    super.onWindowFocusChanged(hasWindowFocus)
  }
}
