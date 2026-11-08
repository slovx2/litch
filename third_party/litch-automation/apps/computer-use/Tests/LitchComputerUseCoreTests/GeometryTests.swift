import XCTest

@testable import LitchComputerUseCore

final class GeometryTests: XCTestCase {
  func testScreenshotRejectsMissingAndAmbiguousWindowInsteadOfPickingNearest() {
    let target = Rect(x: 10, y: 20, width: 400, height: 300)
    let other = Rect(x: 40, y: 20, width: 400, height: 300)
    XCTAssertNil(Geometry.matchingWindowIndex(frames: [], target: target))
    XCTAssertNil(Geometry.matchingWindowIndex(frames: [other], target: target))
    XCTAssertNil(Geometry.matchingWindowIndex(frames: [target, target], target: target))
    XCTAssertEqual(Geometry.matchingWindowIndex(frames: [other, target], target: target), 1)
  }

  func testRetinaWindowUnderCapKeepsFullResolution() {
    let size = Geometry.screenshotSize(window: Size(width: 700, height: 500), backingScale: 2)
    XCTAssertEqual(size.width, 1400)
    XCTAssertEqual(size.height, 1000)
  }

  func testLongestEdgeIsCapped() {
    let size = Geometry.screenshotSize(window: Size(width: 1600, height: 1000), backingScale: 2)
    XCTAssertEqual(size.width, Geometry.maxScreenshotEdge)
    XCTAssertEqual(size.height, 980)
    let tall = Geometry.screenshotSize(window: Size(width: 400, height: 2000), backingScale: 1)
    XCTAssertEqual(tall.height, Geometry.maxScreenshotEdge)
    XCTAssertEqual(tall.width, 314)
  }

  func testZeroScaleFallsBackToOne() {
    let size = Geometry.screenshotSize(window: Size(width: 300, height: 200), backingScale: 0)
    XCTAssertEqual(size.width, 300)
  }

  func testImagePointToScreenOnRetina() {
    // 窗口 800×600 点，在 (100, 50)；截图 1568×1176 像素（Retina 再缩小）
    let window = Rect(x: 100, y: 50, width: 800, height: 600)
    let image = Size(width: 1568, height: 1176)
    let point = Geometry.screenPoint(
      imagePoint: Point(x: 784, y: 588), image: image, capturedWindow: window.size, window: window)
    XCTAssertEqual(point, Point(x: 500, y: 350))
    let corner = Geometry.screenPoint(
      imagePoint: Point(x: 0, y: 0), image: image, capturedWindow: window.size, window: window)
    XCTAssertEqual(corner, Point(x: 100, y: 50))
  }

  func testWindowMovedKeepsRelativePosition() {
    let captured = Size(width: 400, height: 300)
    let moved = Rect(x: -1200, y: 300, width: 400, height: 300)  // 挪到了左边的副屏上
    let point = Geometry.screenPoint(
      imagePoint: Point(x: 400, y: 300), image: Size(width: 800, height: 600),
      capturedWindow: captured, window: moved)
    XCTAssertEqual(point, Point(x: -1000, y: 450))
  }

  func testResizedWindowIsStale() {
    let point = Geometry.screenPoint(
      imagePoint: Point(x: 10, y: 10), image: Size(width: 800, height: 600),
      capturedWindow: Size(width: 400, height: 300), window: Rect(x: 0, y: 0, width: 500, height: 300))
    XCTAssertNil(point)
  }

  func testRoundTrip() {
    let window = Rect(x: 37, y: 81, width: 913, height: 577)
    let image = Size(width: 1568, height: 991)
    let screen = Point(x: 512.5, y: 300.25)
    let pixel = Geometry.imagePoint(screenPoint: screen, image: image, window: window)!
    let back = Geometry.screenPoint(
      imagePoint: pixel, image: image, capturedWindow: window.size, window: window)!
    XCTAssertEqual(back.x, screen.x, accuracy: 1e-9)
    XCTAssertEqual(back.y, screen.y, accuracy: 1e-9)
  }

  func testInside() {
    let image = Size(width: 100, height: 50)
    XCTAssertTrue(Geometry.inside(Point(x: 0, y: 0), image: image))
    XCTAssertTrue(Geometry.inside(Point(x: 99.5, y: 49), image: image))
    XCTAssertFalse(Geometry.inside(Point(x: 100, y: 10), image: image))
    XCTAssertFalse(Geometry.inside(Point(x: -1, y: 10), image: image))
  }
}
