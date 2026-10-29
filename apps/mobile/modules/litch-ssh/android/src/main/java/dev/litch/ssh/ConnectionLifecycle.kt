package dev.litch.ssh

import android.app.AlarmManager
import android.app.Application
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import sshtransport.BackgroundScheduler
import sshtransport.Sshtransport

// 进程 START/STOP 不把通知弹层失焦算作后台；晚加载模块时也读取真实生命周期。
class ConnectionLifecycle : DefaultLifecycleObserver {
  private val main = Handler(Looper.getMainLooper())
  private var alarms: AlarmManager? = null
  private var pending: PendingIntent? = null

  fun attach(application: Application) {
    main.post {
      alarms = application.getSystemService(AlarmManager::class.java)
      Sshtransport.setBackgroundScheduler(object : BackgroundScheduler {
        override fun nowMillis(): Long = SystemClock.elapsedRealtime()

        override fun schedule(deadlineMillis: Long, epoch: Long) {
          main.post {
            cancelAlarm()
            val intent = Intent(application, BackgroundDeadlineReceiver::class.java)
              .setData(Uri.parse("litch-background:${BackgroundDeadlineReceiver.processToken}/$epoch"))
              .putExtra("epoch", epoch)
              .putExtra("process", BackgroundDeadlineReceiver.processToken)
            val operation = PendingIntent.getBroadcast(application, 0, intent,
              PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            pending = operation
            // 非精确、非唤醒；深睡计入期限，系统允许运行后投递，不申请新权限。
            alarms?.set(AlarmManager.ELAPSED_REALTIME, deadlineMillis, operation)
          }
        }

        override fun cancel() { main.post { cancelAlarm() } }
      })
      val lifecycle = ProcessLifecycleOwner.get().lifecycle
      Sshtransport.setAppBackground(!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
      lifecycle.addObserver(this)
    }
  }

  fun detach() {
    main.post {
      ProcessLifecycleOwner.get().lifecycle.removeObserver(this)
      Sshtransport.setAppBackground(false)
      Sshtransport.setBackgroundScheduler(null)
      cancelAlarm()
    }
  }

  private fun cancelAlarm() {
    pending?.let { alarms?.cancel(it); it.cancel() }
    pending = null
  }

  override fun onStart(owner: LifecycleOwner) { Sshtransport.setAppBackground(false) }
  override fun onStop(owner: LifecycleOwner) { Sshtransport.setAppBackground(true) }
}
