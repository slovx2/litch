package dev.litch.ssh

import android.app.Application
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import sshtransport.ConnectionPolicyObserver
import sshtransport.Sshtransport

// 只做转手：参数和结果都是 JSON 字符串，解析在 JS 那头。Go 的调用会阻塞，AsyncFunction 在后台线程上跑
class LitchSshModule : Module() {
  private val lifecycle = ConnectionLifecycle()
  private var application: Application? = null
  private var tailscaleNetwork: TailscaleNetwork? = null
  private var lastTailState: String? = null

  private fun observeTailState(encoded: String): String {
    val status = JSONObject(encoded)
    // 只记录状态和是否已有登录入口，绝不记录 URL、网络图或节点秘密。
    val state = "state=${status.optString("state")} authURL=${status.optString("authURL").isNotEmpty()}"
    if (state != lastTailState) {
      Log.i("LitchTailscale", state)
      lastTailState = state
    }
    return encoded
  }

  private fun prepareNetwork(target: String) {
    if (JSONObject(target).optString("tailscale", "auto") != "never") tailscaleNetwork?.attach()
  }

  override fun definition() = ModuleDefinition {
    Name("LitchSsh")
    Events("onConnectionPolicy")

    OnCreate {
      application = appContext.reactContext?.applicationContext as? Application
      application?.let { app ->
        tailscaleNetwork = TailscaleNetwork(app)
        // 可选网络的初始化失败不能阻止普通 SSH；实际选择内嵌网络时再重试并报告错误。
        try { tailscaleNetwork?.attach() } catch (_: Exception) { }
        val prefs = app.getSharedPreferences("tailscale", 0)
        val hostname = prefs.getString("hostname", null) ?: ("litch-android-" + java.util.UUID.randomUUID().toString().take(8)).also {
          prefs.edit().putString("hostname", it).commit()
        }
        // 解密失败不阻止整个应用启动，状态页仍可清除损坏的状态。
        try {
          Sshtransport.tailscaleInitialize(java.io.File(app.noBackupFilesDir, "tailscale-node").absolutePath, hostname, TailscaleStorage(app))
        } catch (_: Exception) { }
      }
      application?.let { lifecycle.attach(it) }
      Sshtransport.setConnectionPolicyObserver(object : ConnectionPolicyObserver {
        override fun onConnectionPolicy(state: String) {
          // 只记录前后台与暂停状态，供诊断实际断开时刻；不含设备、密钥或消息。
          Log.i("LitchConnection", "$state elapsedMs=${SystemClock.elapsedRealtime()} uptimeMs=${SystemClock.uptimeMillis()}")
          sendEvent("onConnectionPolicy", mapOf("state" to state))
        }
      })
    }

    OnDestroy {
      tailscaleNetwork?.detach()
      Sshtransport.tailscaleStop()
      lifecycle.detach()
      Sshtransport.setConnectionPolicyObserver(null)
    }

    Function("setBackgroundTimeout") { minutes: Int -> Sshtransport.setBackgroundTimeout(minutes.toLong()) }
    Function("connectionPolicyState") { Sshtransport.connectionPolicyState() }
    Function("batteryOptimization") {
      batteryOptimization(appContext.reactContext ?: throw Exceptions.ReactContextLost())
    }
    Function("openBackgroundSettings") {
      openBackgroundSettings(appContext.reactContext ?: throw Exceptions.ReactContextLost())
    }

    Function("tailscaleAvailable") { tailscaleNetwork != null }
    AsyncFunction("connectionRoute") { host: String, port: Int, mode: String ->
      Sshtransport.connectionRoute(host, port.toLong(), mode)
    }
    AsyncFunction("tailscaleStatus") { observeTailState(Sshtransport.tailscaleStatus()) }
    AsyncFunction("tailscaleLogin") { controlURL: String ->
      tailscaleNetwork?.attach()
      observeTailState(Sshtransport.tailscaleLogin(controlURL))
    }
    AsyncFunction("tailscaleLogout") { Sshtransport.tailscaleLogout() }
    AsyncFunction("tailscaleClear") { Sshtransport.tailscaleClear() }

    AsyncFunction("probeHost") { host: String, port: Int, user: String, tailscale: String ->
      if (tailscale != "never") tailscaleNetwork?.attach()
      Sshtransport.probeHost(host, port.toLong(), user, tailscale)
    }

    AsyncFunction("runScript") { target: String, script: String, marker: String ->
      prepareNetwork(target)
      Sshtransport.runScript(target, script, marker)
    }

    AsyncFunction("openStream") { id: String, target: String, script: String, marker: String ->
      prepareNetwork(target)
      Sshtransport.openStream(id, target, script, marker)
    }

    AsyncFunction("streamState") { id: String ->
      Sshtransport.streamState(id)
    }

    AsyncFunction("closeStream") { id: String ->
      Sshtransport.closeStream(id)
    }

    AsyncFunction("generateEd25519Key") {
      Sshtransport.generateEd25519Key()
    }

    AsyncFunction("inspectPrivateKey") { privateKey: String, passphrase: String ->
      Sshtransport.inspectPrivateKey(privateKey, passphrase)
    }

    AsyncFunction("enrollPair") { target: String, line: String ->
      prepareNetwork(target)
      Sshtransport.enrollPair(target, line)
    }

    AsyncFunction("pairConfirmCode") { pairId: String, publicKey: String, approvalKey: String ->
      Sshtransport.pairConfirmCode(pairId, publicKey, approvalKey)
    }

    AsyncFunction("pairPhoneId") { publicKey: String ->
      Sshtransport.pairPhoneID(publicKey)
    }

    AsyncFunction("newApprovalKey") {
      Sshtransport.newApprovalKey()
    }

    AsyncFunction("approvalSign") { seed: String, text: String ->
      Sshtransport.approvalSign(seed, text)
    }

    AsyncFunction("approvalFingerprint") { approvalKey: String ->
      Sshtransport.approvalFingerprint(approvalKey)
    }
  }
}
