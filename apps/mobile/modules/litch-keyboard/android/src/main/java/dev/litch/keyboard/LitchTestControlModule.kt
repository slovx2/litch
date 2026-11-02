package dev.litch.keyboard

import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** 只供端到端反例验收：阻塞真正的 Android 主线程，不能用 JS 卡顿冒充 ANR。 */
class LitchTestControlModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LitchTestControl")
    Function("blockMainThread") { mode: String ->
      require(mode == "mock" || mode == "fixture") { "ANR injection requires a test boot mode" }
      Handler(Looper.getMainLooper()).post {
        Log.w("LitchTestControl", "ANR injection: main thread blocked in $mode mode")
        Thread.sleep(30000)
        Log.w("LitchTestControl", "ANR injection: main thread released")
      }
    }
  }
}
