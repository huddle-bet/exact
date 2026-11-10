import XCTest
import CoreGraphics
@testable import ExactKit

/// An image's `load` record: where its ink sits. The bug each catches: a
/// cut-out read as full frame (or the reverse) draws a plate where the app
/// wants none; a context that cannot draw alpha reads every image as empty.
final class ImageInkTests: XCTestCase {
    /// A width × height RGBA image, clear, with `rects` (top-left origin) filled opaque.
    private func image(_ width: Int, _ height: Int, _ rects: [CGRect]) throws -> CGImage {
        let ctx = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        ctx.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.6, alpha: 1))
        for r in rects { ctx.fill(CGRect(x: r.minX, y: CGFloat(height) - r.maxY, width: r.width, height: r.height)) }
        return try XCTUnwrap(ctx.makeImage())
    }

    func testAFullFrameImageFillsItsBox() throws {
        let m = try XCTUnwrap(ImageInk.measure(try image(100, 100, [CGRect(x: 0, y: 0, width: 100, height: 100)])))
        XCTAssertEqual(Array(m[0..<5]), [0, 0, 1, 1, 1])
        XCTAssertEqual(Array(m[5...]), [0, 0, 1])
    }

    func testACutOutReportsItsInkTopAndFoot() throws {
        // A head (40..60 wide, rows 10..40) over shoulders (20..80 wide, rows 40..100): clear above and beside.
        let m = try XCTUnwrap(ImageInk.measure(try image(100, 100, [CGRect(x: 40, y: 10, width: 20, height: 30),
                                                                     CGRect(x: 20, y: 40, width: 60, height: 60)])))
        XCTAssertEqual(Array(m[0..<4]), [0.2, 0.1, 0.8, 1])
        XCTAssertLessThan(m[4], 0.98, "the hull leaves the clear corners out")
        XCTAssertEqual(Array(m[5...]), [0.1, 0.2, 0.8])
    }

    func testALargeImageIsReadAtMostOneHundredFiftyOnItsLongerSide() throws {
        let m = try XCTUnwrap(ImageInk.measure(try image(600, 300, [CGRect(x: 150, y: 0, width: 300, height: 300)])))
        // Each read pixel takes the source pixel under its centre: read pixel 37 covers source 150, the ink's first
        // column, and read pixel 111 the last, so the ink spans 37 to 112 of 150.
        XCTAssertEqual(Array(m[0..<4]), [0.2467, 0, 0.7467, 1])
    }

    func testAClearImageHasNoInk() throws {
        XCTAssertNil(ImageInk.measure(try image(40, 40, [])))
        XCTAssertEqual(ImageInk.payload(try image(40, 40, []), natural: CGSize(width: 40, height: 40)), "40,40,0,0,0,0,0,0,0,0")
    }
}
