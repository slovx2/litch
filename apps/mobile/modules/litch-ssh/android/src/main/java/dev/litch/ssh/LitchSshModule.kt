package dev.litch.ssh

import android.app.Application
import android.util.Log
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import sshtransport.ConnectionPolicyObserver
import sshtransport.Sshtransport

// 只做转手：参数和结果都是 JSON 字符串，解析在 JS 那头。Go 的调用会阻塞，AsyncFunction 在后台线程上跑
class LitchSshModule : Module() {
  private val lifecycle = ConnectionLifecycle()
  private var application: Application? = null

  override fun definition() = ModuleDefinition {
    Name("LitchSsh")
    Events("onConnectionPolicy")

    OnCreate {
      application = appContext.reactContext?.applicationContext as? Application
      application?.let { lifecycle.attach(it, appContext.currentActivity) }
      Sshtransport.setConnectionPolicyObserver(object : ConnectionPolicyObserver {
        override fun onConnectionPolicy(state: String) {
          // 只记录前后台与暂停状态，供诊断实际断开时刻；不含设备、密钥或消息。
          Log.i("LitchConnection", state)
          sendEvent("onConnectionPolicy", mapOf("state" to state))
        }
      })
    }

    OnDestroy {
      application?.unregisterActivityLifecycleCallbacks(lifecycle)
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

    AsyncFunction("probeHost") { host: String, port: Int, user: String ->
      Sshtransport.probeHost(host, port.toLong(), user)
    }

    AsyncFunction("runScript") { target: String, script: String, marker: String ->
      Sshtransport.runScript(target, script, marker)
    }

    AsyncFunction("openStream") { id: String, target: String, script: String, marker: String ->
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
