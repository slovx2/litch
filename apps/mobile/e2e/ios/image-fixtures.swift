// 仅生成测试色块，不读取用户照片。导入模拟器后，最新三张分别覆盖 JPEG、HEIC、PNG。
import CoreGraphics
import ImageIO
import Foundation

let context = CGContext(data: nil, width: 64, height: 48, bitsPerComponent: 8,
  bytesPerRow: 256, space: CGColorSpaceCreateDeviceRGB(),
  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 0.9, green: 0.2, blue: 0.1, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
let image = context.makeImage()!
for (name, type) in [("fixture.png", "public.png"), ("fixture.heic", "public.heic"), ("fixture.jpg", "public.jpeg")] {
  let url = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent(name)
  let destination = CGImageDestinationCreateWithURL(url as CFURL, type as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, image, nil)
  precondition(CGImageDestinationFinalize(destination))
}
