import ExpoModulesCore
import OSLog
import Sshtransport

// Go 同步函数留在 Expo 的后台队列；只把 JSON 和错误原样交还 JS。
public final class LitchSshModule: Module {
  private let lifecycle = ConnectionLifecycle()
  private var observer: PolicyObserver?

  public func definition() -> ModuleDefinition {
    Name("LitchSsh")
    Events("onConnectionPolicy")
    OnCreate { [weak self] in
      guard let self else { return }
      let observer = PolicyObserver { [weak self] state in
        self?.sendEvent("onConnectionPolicy", ["state": state])
      }
      self.observer = observer
      SshtransportSetConnectionPolicyObserver(observer)
      self.lifecycle.attach()
    }
    OnDestroy { [weak self] in
      SshtransportSetConnectionPolicyObserver(nil)
      self?.lifecycle.detach()
      self?.observer = nil
    }
    Function("setBackgroundTimeout") { (minutes: Int) in
      SshtransportSetBackgroundTimeout(minutes)
    }
    Function("connectionPolicyState") { SshtransportConnectionPolicyState() }
    Function("batteryOptimization") { "unknown" }
    Function("openBackgroundSettings") { false }
    AsyncFunction("probeHost") { (host: String, port: Int, user: String) in
      try goString { SshtransportProbeHost(host, port, user, $0) }
    }
    AsyncFunction("runScript") { (target: String, script: String, marker: String) in
      try goString { SshtransportRunScript(target, script, marker, $0) }
    }
    AsyncFunction("openStream") { (id: String, target: String, script: String, marker: String) in
      try goString { SshtransportOpenStream(id, target, script, marker, $0) }
    }
    AsyncFunction("streamState") { (id: String) in
      try goString { SshtransportStreamState(id, $0) }
    }
    AsyncFunction("closeStream") { (id: String) in SshtransportCloseStream(id) }
    AsyncFunction("generateEd25519Key") {
      try goString { SshtransportGenerateEd25519Key($0) }
    }
    AsyncFunction("inspectPrivateKey") { (key: String, passphrase: String) in
      try goString { SshtransportInspectPrivateKey(key, passphrase, $0) }
    }
    AsyncFunction("enrollPair") { (target: String, line: String) in
      try goString { SshtransportEnrollPair(target, line, $0) }
    }
    AsyncFunction("pairConfirmCode") { (id: String, key: String, approval: String) in
      SshtransportPairConfirmCode(id, key, approval)
    }
    AsyncFunction("pairPhoneId") { (key: String) in
      try goString { SshtransportPairPhoneID(key, $0) }
    }
    AsyncFunction("newApprovalKey") { try goString { SshtransportNewApprovalKey($0) } }
    AsyncFunction("approvalSign") { (seed: String, text: String) in
      try goString { SshtransportApprovalSign(seed, text, $0) }
    }
    AsyncFunction("approvalFingerprint") { (key: String) in
      try goString { SshtransportApprovalFingerprint(key, $0) }
    }
  }
}

// C 函数不会自动桥接成 throws；不能把 Go 的失败误当成空字符串。
func goString(_ call: (AutoreleasingUnsafeMutablePointer<NSError?>) -> String) throws -> String {
  var error: NSError?
  let result = call(&error)
  if let error { throw error }
  return result
}

private final class PolicyObserver: NSObject, SshtransportConnectionPolicyObserverProtocol {
  private let logger = Logger(subsystem: "dev.litch.connection", category: "lifecycle")
  private let changed: (String) -> Void
  init(changed: @escaping (String) -> Void) { self.changed = changed }
  func onConnectionPolicy(_ state: String?) {
    let state = state ?? "{}"
    // 仅含前后台、暂停和修订号，不能记录 SSH 参数或 Go 错误里的凭据。
    logger.info("Connection policy: \(state, privacy: .public)")
    changed(state)
  }
}
