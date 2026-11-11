#if os(iOS)
import UIKit
import XCTest
@testable import ExactKit

final class MaterialTableIOSTests: XCTestCase {
    func testEveryMaterialIsAUIKitOne() throws {
        try MaterialTable.check(1) { Materials.blurStyle($0) != nil }
    }

    /// Named materials reach their styles; `backdrop-filter` alone draws
    /// `.light`.
    func testNamedMaterialsAndABareBlurDrawTheirStyles() {
        XCTAssertEqual(Backdrop.material, .light)
        for (name, style) in [("thin", UIBlurEffect.Style.systemThinMaterial), ("chrome-dark", .systemChromeMaterialDark), ("prominent", .prominent)] {
            XCTAssertEqual(Materials.blurStyle(Materials.platform(name)!.apple), style, name)
        }
        XCTAssertEqual(Materials.platform("sidebar")?.standIn, true, "an AppKit material draws a stand-in")
    }

    func testTheBlurRadiusIsTheStrengthAndTheAppearanceIsTheTint() {
        XCTAssertEqual(Backdrop.fraction(of: [.blur(Backdrop.fullSigma / 2)]), 0.5)
        XCTAssertEqual(Backdrop.fraction(of: [.blur(100)]), 1)
        XCTAssertEqual(Backdrop.fraction(of: [.blur(0)]), 0)
        XCTAssertEqual(Backdrop.fraction(of: [.saturate(2), .blur(5)]), 0.25)
        XCTAssertEqual(Backdrop.fraction(of: [.saturate(2)]), 1)
        XCTAssertEqual(Backdrop.style(dark: false), .light)
        XCTAssertEqual(Backdrop.style(dark: true), .dark)
        let p = Presenter()
        let node = NodeView(id: 1, kind: "view", presenter: p)
        node.applyStyle(["backdrop_filter": [["blur": 5]]])
        XCTAssertEqual((node.materialView as? BackdropEffectView)?.drawn?.fraction, 0.25)
        node.applyStyle(["backdrop_filter": [["blur": 15]]])
        XCTAssertEqual((node.materialView as? BackdropEffectView)?.drawn?.fraction, 0.75, "a new radius redraws")
        node.applyStyle(["backdrop_filter": [["blur": 30]]])
        let view = node.materialView as? BackdropEffectView
        XCTAssertEqual(view?.drawn?.fraction, 1)
        XCTAssertNotNil(view?.effect)
    }

    func testAMaskGradientMasksTheBlur() {
        let p = Presenter()
        let node = NodeView(id: 1, kind: "view", presenter: p)
        node.frame = CGRect(x: 0, y: 0, width: 100, height: 60)
        node.applyStyle(["backdrop_filter": [["blur": 10]], "mask_image": ["linear": 180, "stops": [0, 0, 0, 0, 1, 1, 0, 0, 0, 0]]])
        node.applyBoxMask()
        XCTAssertNotNil(node.materialView?.mask)
    }

    func testSaturationKeepsTheDeclaredMaterialApproximation() {
        let p = Presenter()
        let node = NodeView(id: 1, kind: "view", presenter: p)
        node.applyStyle(["backdrop_filter": [["saturate": 0]]])
        XCTAssertEqual(node.materialRequest, "backdrop")
        XCTAssertTrue(node.materialView is BackdropEffectView)
        XCTAssertEqual((node.materialView as? BackdropEffectView)?.operations, [.saturate(0)])
        node.applyStyle([:])
        XCTAssertNil(node.materialRequest)
        XCTAssertNil(node.materialView)
    }
}
#endif
