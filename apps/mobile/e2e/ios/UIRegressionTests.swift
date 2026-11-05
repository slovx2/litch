import XCTest

// 按原生无障碍元素点击，独立核对 Maestro 的点击偏差与真实产品行为。
final class UIRegressionTests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "dev.litch.app.dev")

  override func setUpWithError() throws {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    app.terminate()
    app.launch()
    XCTAssertTrue(app.otherElements["devices"].waitForExistence(timeout: 15))
    // 相同 mode 不会重新装核心；先切换到 stored，再建立受控的全新 mock。
    app.open(URL(string: "litch-dev://boot?mode=stored")!)
    app.open(URL(string: "litch-dev://boot?mode=mock&controlled=1")!)
    reveal(app.buttons["device:local"])
  }

  override func tearDown() {
    if (testRun?.failureCount ?? 0) > 0 { print("LITCH_UI_REGRESSION_FAILURE \(app.debugDescription)") }
    XCUIDevice.shared.orientation = .portrait
  }

  func testAuthorizationCodeDoesNotOpenBrowser() {
    harness("local", "claude")
    tap("hc:tab:accounts:pick")
    tap("hc:provider:anthropic:method:console")
    let code = app.textFields.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "hc:attempt:", ":code")).firstMatch
    reveal(code)
    code.tap()
    XCTAssertEqual(app.state, .runningForeground)
    code.typeText("abc#def")
    XCTAssertEqual(code.value as? String, "abc#def")
    dismissKeyboard()
    let send = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "hc:attempt:", ":send")).firstMatch
    reveal(send)
    send.tap()
    let done = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "hc:attempt:", ":done")).firstMatch
    XCTAssertTrue(done.waitForExistence(timeout: 10))
    XCTAssertEqual(app.state, .runningForeground)
  }

  func testProposalMenu() {
    tap("device:local")
    tap("sessions:new")
    let input = app.textViews["new-input"]
    XCTAssertTrue(input.waitForExistence(timeout: 10))
    input.tap()
    input.typeText("propose a sub-session")
    tap("new-send")
    XCTAssertTrue(app.buttons["detail:proposals"].waitForExistence(timeout: 20))
    tap("proposal:e2e-pr1:more", up: false)
    tap("proposal:e2e-pr1:dismiss")
    let dismissed = app.staticTexts.matching(NSPredicate(format: "label == %@ OR label == %@", "Dismissed", "已忽略")).firstMatch
    XCTAssertTrue(dismissed.waitForExistence(timeout: 10))
  }

  func testAddModelForm() {
    harness("build", "codex")
    tap("hc:tab:models:pick")
    XCTAssertTrue(app.descendants(matching: .any)["hc:models:state:builtin"].waitForExistence(timeout: 10))
    tap("hc:models:start")
    tap("hc:model:o5-pro")
    tap("hc:model:remove")
    tap("hc:model:gpt-5.4")
    tap("hc:model:up")
    tap("hc:models:add")
    XCTAssertTrue(app.otherElements["hc:modelForm"].waitForExistence(timeout: 10))
    tap("hc:modelForm:base:gpt-5.5", up: false)
    tap("hc:modelForm:mode:custom")
    let input = app.textFields["hc:modelForm:id"]
    reveal(input)
    input.tap()
    let old = input.value as? String ?? ""
    input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count) + "team-long")
    XCTAssertEqual(input.value as? String, "team-long")
  }

  func testWorktreeDefaultsAndSheet() {
    tap("device:local")
    tap("sessions:new")
    tap("new:where:litch")
    tap("new:place:worktree")
    tap("new:from")
    let branch = app.descendants(matching: .any)["picker:option:branch:release/0.18"]
    XCTAssertTrue(branch.waitForExistence(timeout: 10))
    branch.tap()
    XCTAssertTrue(app.buttons["new:from"].label.hasSuffix(", release/0.18"))
    let input = app.textViews["new-input"]
    input.tap()
    input.typeText("propose a sub-session")
    tap("new-send")
    XCTAssertTrue(app.buttons["detail:proposals"].waitForExistence(timeout: 20))
    let explicit = app.switches["proposal:e2e-pr3:worktree"]
    XCTAssertTrue(explicit.waitForExistence(timeout: 10))
    print("LITCH_WORKTREE_SWITCH explicit=\(explicit.value ?? "nil") enabled=\(explicit.isEnabled) frame=\(explicit.frame)")
    XCTAssertEqual(explicit.value as? String, "0")
    let inherited = app.switches["proposal:e2e-pr1:worktree"]
    XCTAssertTrue(inherited.exists)
    print("LITCH_WORKTREE_SWITCH inherited=\(inherited.value ?? "nil") enabled=\(inherited.isEnabled) frame=\(inherited.frame)")
    XCTAssertEqual(inherited.value as? String, "1")
    tap("detail:menu")
    tap("detail:menu:worktree")
    XCTAssertEqual(app.staticTexts["worktree:base"].label, "release/0.18")
    tap("worktree:sync")
    XCTAssertTrue(app.staticTexts["worktree:synced"].waitForExistence(timeout: 10))
    app.descendants(matching: .any)["worktree:scrim"].tap()
    tap("header:back")
    let row = app.buttons["session:s5"]
    reveal(row)
    XCTAssertTrue(row.label.contains("litch/sidebar-tweaks-3f2a1c"))
  }

  func testManualTailscaleFieldsRetainInput() {
    app.open(URL(string: "litch-dev://home")!)
    tap("devices:add")
    let toggle = app.buttons["tailscale:mode"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 10))
    toggle.tap()
    tap("tailscale:mode:always")
    tap("tailscale:guide")
    // 清空节点以保证最后应报未登录，而不是让网络环境决定断言。
    tap("tailscale:clear")
    tap("confirm:ok")
    tap("tailscale:back")
    let host = app.textFields["add:host"]
    reveal(host)
    host.tap()
    host.typeText("100.64.0.2")
    XCTAssertEqual(host.value as? String, "100.64.0.2")
    let user = app.textFields["add:user"]
    XCTAssertTrue(user.waitForExistence(timeout: 5))
    // 直接按元素点击，让 XCTest 的 scroll-to-visible 处理键盘遮挡，不给它屏幕坐标。
    user.tap()
    user.typeText("test")
    XCTAssertEqual(user.value as? String, "test")
    dismissKeyboard()
    tap("key:generate")
    tap("add:check")
    let error = app.staticTexts["add:error"]
    XCTAssertTrue(error.waitForExistence(timeout: 10))
    XCTAssertTrue(error.label.contains("Tailscale"), error.label)
    XCTAssertTrue(error.label.contains("登录") || error.label.contains("Sign in"), error.label)
  }

  private func harness(_ device: String, _ engine: String) {
    tap("device:\(device):more")
    tap("menu:detail")
    tap("harness:\(engine):settings")
  }

  private func tap(_ id: String, up: Bool = true) {
    let element = app.buttons[id]
    reveal(element, up: up)
    element.tap()
  }

  private func reveal(_ element: XCUIElement, up: Bool = true) {
    for _ in 0..<8 {
      if element.exists && element.isHittable { return }
      // 已在树中的元素可能被上一次滚动带到顶部外；按它的位置决定方向，不反复越滚越远。
      let towardBottom = element.exists ? element.frame.midY > app.frame.midY : up
      if towardBottom { app.swipeUp() } else { app.swipeDown() }
    }
    XCTAssertTrue(element.exists && element.isHittable, "元素不可点击: \(element)")
  }

  private func dismissKeyboard() {
    let done = app.buttons["keyboard:done"]
    if done.exists { done.tap() }
    else if app.keyboards.buttons["Return"].exists { app.keyboards.buttons["Return"].tap() }
  }
}
