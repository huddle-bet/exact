#if os(iOS)
import UIKit
import XCTest
@testable import ExactKit

final class TopOverlayIOSTests: XCTestCase {
    func testTheOverlayWindowTakesATouchOnlyWhereAPopoverIs() {
        let window = TopOverlayWindow(frame: CGRect(x: 0, y: 0, width: 200, height: 200))
        let controller = TopOverlayController()
        window.rootViewController = controller
        window.isHidden = false
        let popover = UIView(frame: CGRect(x: 50, y: 50, width: 40, height: 40))
        controller.view.addSubview(popover)
        XCTAssertNil(window.hitTest(CGPoint(x: 10, y: 10), with: nil), "empty overlay passes the touch through")
        XCTAssertTrue(window.hitTest(CGPoint(x: 60, y: 60), with: nil) === popover)
        window.isHidden = true
    }
}
#endif
