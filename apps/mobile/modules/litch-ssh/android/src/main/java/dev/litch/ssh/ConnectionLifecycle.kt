package dev.litch.ssh

import android.app.Activity
import android.app.Application
import android.os.Bundle
import sshtransport.Sshtransport

// Expo 的后台事件来自 onPause，通知弹层也会触发。用真正 stopped 的 Activity 开始计时。
class ConnectionLifecycle : Application.ActivityLifecycleCallbacks {
  private val started = mutableSetOf<Activity>()

  fun attach(application: Application, current: Activity?) {
    if (current != null) started.add(current)
    application.registerActivityLifecycleCallbacks(this)
  }

  override fun onActivityStarted(activity: Activity) {
    started.add(activity)
    Sshtransport.setAppBackground(false)
  }

  override fun onActivityStopped(activity: Activity) {
    started.remove(activity)
    if (started.isEmpty() && !activity.isChangingConfigurations) {
      Sshtransport.setAppBackground(true)
    }
  }

  override fun onActivityCreated(activity: Activity, state: Bundle?) {}
  override fun onActivityResumed(activity: Activity) {}
  override fun onActivityPaused(activity: Activity) {}
  override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
  override fun onActivityDestroyed(activity: Activity) { started.remove(activity) }
}
