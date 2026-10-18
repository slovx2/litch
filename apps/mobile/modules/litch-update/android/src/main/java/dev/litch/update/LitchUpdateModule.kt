package dev.litch.update

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.MessageDigest

// 应用自己的更新（设计见工作区 design/harness-client/07-auto-update.md）。下载在 JS 里用 expo-file-system 做，
// 这里只做 JS 做不了或做着太费的几件事：
// - 算安装包的 SHA-256：安装包几十 MB，整个读进 JS 再算既慢又占内存，这里按块读；
// - 看安装包的包名、版本、签名：签名和眼前这个应用不一样时系统一定装不上，先在这里说清楚，不让人去系统安装器里撞；
// - 拉起系统安装器：经 expo-file-system 自带的 FileProvider（授权名 <包名>.FileSystemFileProvider，覆盖缓存目录）给出
//   content 地址，ACTION_VIEW 交给系统自带的安装器。系统安装器装没装上不会回话给我们，装上了应用会被换掉重启。
class LitchUpdateModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("LitchUpdate")

    /** 本应用能不能拉起系统安装器装包（安卓 8 起要人在设置里允许“安装未知应用”；更早的系统由安装器自己问） */
    Function("canInstall") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) true
      else context.packageManager.canRequestPackageInstalls()
    }

    /** 打开系统设置里本应用的“安装未知应用”开关那一页；系统太旧没有这一页时返回 false */
    Function("openInstallSettings") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@Function false
      start(
        Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${context.packageName}"),
        ),
      )
      true
    }

    /** 文件的 SHA-256（小写十六进制）。异步函数跑在模块自己的后台线程上，不卡 JS */
    AsyncFunction("sha256") { path: String ->
      val digest = MessageDigest.getInstance("SHA-256")
      fileOf(path).inputStream().use { input ->
        val buffer = ByteArray(1 shl 20)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          digest.update(buffer, 0, read)
        }
      }
      hex(digest.digest())
    }

    /**
     * 看一份安装包：包名、版本，以及签名和眼前这个应用的是不是同一把钥匙。
     * sameSigner 在系统给不出签名时（安卓 9 以前、读不出来）是 null，交给系统安装器去判断
     */
    AsyncFunction("inspect") { path: String ->
      val manager = context.packageManager
      val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else 0
      @Suppress("DEPRECATION")
      val archive = manager.getPackageArchiveInfo(fileOf(path).path, flags)
        ?: throw CodedException("ERR_NOT_APK", "不是一个能读的安装包", null)
      @Suppress("DEPRECATION")
      val installed = manager.getPackageInfo(context.packageName, flags)
      val archiveSigners = signers(archive)
      val installedSigners = signers(installed)
      mapOf(
        "packageName" to archive.packageName,
        "versionName" to archive.versionName,
        "versionCode" to PackageInfoCompat.getLongVersionCode(archive).toDouble(),
        "installedVersionCode" to PackageInfoCompat.getLongVersionCode(installed).toDouble(),
        "sameSigner" to
          if (archiveSigners == null || installedSigners == null) null else archiveSigners == installedSigners,
      )
    }

    /** 拉起系统安装器装这份安装包（要在缓存目录或文档目录里，FileProvider 只覆盖这两处） */
    Function("install") { path: String ->
      val uri = FileProvider.getUriForFile(
        context,
        "${context.packageName}.FileSystemFileProvider",
        fileOf(path),
      )
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      // 手机上别的应用也可能认安装包（文件管理、网盘），直接交给系统自带的那个安装器；找不到就交给系统去挑
      context.packageManager
        .queryIntentActivities(intent, PackageManager.MATCH_SYSTEM_ONLY)
        .firstOrNull()
        ?.activityInfo
        ?.packageName
        ?.let { intent.setPackage(it) }
      start(intent)
    }
  }

  /** 有前台的活动就从它起（安装器叠在应用上面），没有就另开一个任务 */
  private fun start(intent: Intent) {
    val activity = appContext.currentActivity
    if (activity != null) {
      activity.startActivity(intent)
    } else {
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }

  /** expo-file-system 给的是 file:// 地址，也收裸路径 */
  private fun fileOf(path: String): File {
    val file = if (path.startsWith("file://")) File(Uri.parse(path).path ?: "") else File(path)
    if (!file.isFile) throw CodedException("ERR_NO_FILE", "文件不存在：$path", null)
    return file
  }

  /** 签名证书各算一个 SHA-256，成一个集合；安卓 9 以前不读（返回 null） */
  private fun signers(info: PackageInfo): Set<String>? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
    val signing = info.signingInfo ?: return null
    val certificates = signing.apkContentsSigners ?: return null
    if (certificates.isEmpty()) return null
    return certificates.map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }.toSet()
  }

  private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}
