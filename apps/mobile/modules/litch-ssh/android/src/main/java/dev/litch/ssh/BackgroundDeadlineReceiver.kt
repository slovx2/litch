package dev.litch.ssh

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import java.util.UUID
import sshtransport.Sshtransport

// 使用应用私有广播，避免 listener 闹钟在进程缓存后被系统撤销。
class BackgroundDeadlineReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    // 进程已被杀则连接也已回收；旧闹钟不能影响新进程的后台轮次。
    if (intent.getStringExtra("process") != processToken) return
    Sshtransport.backgroundDeadline(intent.getLongExtra("epoch", -1))
  }

  companion object {
    val processToken: String = UUID.randomUUID().toString()
  }
}
