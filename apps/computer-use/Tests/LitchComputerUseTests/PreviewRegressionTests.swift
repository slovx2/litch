import AppKit
import Darwin
import XCTest
import LitchComputerUseCore
@testable import LitchComputerUse

final class PreviewRegressionTests: XCTestCase {
  func testForegroundInputPassesThroughAllPreviewPanelsAndRestoresFlags() {
    _ = NSApplication.shared
    let panels = (0..<2).map { _ in PreviewPanel(contentRect: .zero,
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false) }
    panels[1].ignoresMouseEvents = true
    let restore = FloatingPreview.passThroughDuringInput()
    XCTAssertTrue(panels.allSatisfy(\.ignoresMouseEvents))
    restore()
    XCTAssertFalse(panels[0].ignoresMouseEvents)
    XCTAssertTrue(panels[1].ignoresMouseEvents)
    for panel in panels { panel.close() }
  }

  func testFirstInputWaitsForSelfTestAndCanBeCancelled() throws {
    BackgroundMouse.finish("pending")
    defer { BackgroundMouse.finish("unavailable") }
    enum Cancel: Error { case stopped }
    XCTAssertThrowsError(try BackgroundMouse.waitForSelfTest { throw Cancel.stopped })
    let entered = DispatchSemaphore(value: 0), returned = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      try? BackgroundMouse.waitForSelfTest { entered.signal() }
      returned.signal()
    }
    XCTAssertEqual(entered.wait(timeout: .now() + 1), .success)
    XCTAssertEqual(returned.wait(timeout: .now() + 0.05), .timedOut)
    BackgroundMouse.finish("available")
    XCTAssertEqual(returned.wait(timeout: .now() + 1), .success)
  }

  func testPreviewControlsPassBlockedOrdinaryRequest() throws {
    var fds: [Int32] = [-1, -1]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
    let server = Server(socketPath: "/unused") { _ in fatalError("不启动监听") }
    let connection = Connection(id: 1, fd: fds[0], server: server)
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    let methods = ["previewSubscribe", "previewPin", "previewUnpin", "stopSession"]
    let delivered = expectation(description: "长动作尚未完成时控制请求已执行")
    delivered.expectedFulfillmentCount = methods.count
    let handler = BlockingHandler(entered: entered, release: release) { method in
      XCTAssertTrue(methods.contains(method)); delivered.fulfill()
    }
    connection.handler = handler; connection.authenticated = true
    let reader = Thread { connection.run() }; reader.start()
    defer { release.signal(); shutdown(fds[1], SHUT_RDWR); close(fds[1]) }
    func send(_ method: String) throws {
      let frame = try Wire.frame(RPC.notification(method, .null))
      XCTAssertTrue(SocketWriter.write(frame, to: fds[1]))
    }
    try send("typeText")
    XCTAssertEqual(entered.wait(timeout: .now() + 1), .success)
    for method in methods { try send(method) }
    wait(for: [delivered], timeout: 1)
  }

  func testLargeBitmapDoesNotIncreaseConstrainedPreviewSize() {
    let root = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 240))
    let image = PreviewImageView()
    image.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(image)
    NSLayoutConstraint.activate([
      image.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      image.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      image.topAnchor.constraint(equalTo: root.topAnchor),
      image.bottomAnchor.constraint(equalTo: root.bottomAnchor),
    ])
    for size in [NSSize(width: 1280, height: 1024), NSSize(width: 3840, height: 2160)] {
      image.image = NSImage(size: size)
      root.layoutSubtreeIfNeeded()
      XCTAssertEqual(image.intrinsicContentSize, NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric))
      XCTAssertEqual(image.frame.size, root.frame.size)
      XCTAssertLessThanOrEqual(root.fittingSize.width, 360)
      XCTAssertLessThanOrEqual(root.fittingSize.height, 240)
    }
  }
}

private final class BlockingHandler: ConnectionHandler {
  let entered: DispatchSemaphore, release: DispatchSemaphore
  let control: (String) -> Void
  init(entered: DispatchSemaphore, release: DispatchSemaphore, control: @escaping (String) -> Void) {
    self.entered = entered; self.release = release; self.control = control
  }
  func handle(method: String, params: JSONValue) throws -> JSONValue {
    if method == "typeText" { entered.signal(); _ = release.wait(timeout: .now() + 3) }
    else { control(method) }
    return .null
  }
  func closed() {}
}
