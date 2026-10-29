package dev.litch.ssh

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

// 标准白名单不是厂商的全部后台开关，界面必须分别说明。
fun batteryOptimization(context: Context): String = try {
  val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
  if (power.isIgnoringBatteryOptimizations(context.packageName)) "exempt" else "restricted"
} catch (_: Exception) {
  "unknown"
}

fun openBackgroundSettings(context: Context): Boolean {
  // 已核对的 ColorOS 耗电页未导出，另一入口要求厂商签名权限；公开的应用详情页可进入耗电管理。
  // 不拼猜测的私有参数，也不尝试越过系统权限。
  val intent = Intent(
    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
    Uri.parse("package:${context.packageName}"),
  ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  return try {
    context.startActivity(intent)
    true
  } catch (_: ActivityNotFoundException) {
    false
  } catch (_: SecurityException) {
    false
  }
}
