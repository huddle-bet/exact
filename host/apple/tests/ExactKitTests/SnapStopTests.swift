import XCTest
@testable import ExactKit

final class SnapStopTests: XCTestCase {
    private let areas = [0.0, 316, 632, 948].map { SnapArea(start: $0, end: $0, stops: true) }

    func testAForwardFlingEndsAtTheNextStoppingArea() {
        XCTAssertEqual(SnapStop.limit(948, from: 0, areas: areas), 316)
        XCTAssertEqual(SnapStop.limit(632, from: 316, areas: areas), 632)
    }

    func testABackwardFlingEndsAtThePreviousStoppingArea() {
        XCTAssertEqual(SnapStop.limit(0, from: 948, areas: areas), 632)
    }

    func testAreasThatDoNotStopAreFlownOver() {
        let loose = areas.map { SnapArea(start: $0.start, end: $0.end, stops: false) }
        XCTAssertEqual(SnapStop.limit(948, from: 0, areas: loose), 948)
    }

    func testAnAreaThatIsNotBetweenTheStartAndTheTargetDoesNotLimit() {
        XCTAssertEqual(SnapStop.limit(316, from: 0, areas: areas), 316)
        XCTAssertEqual(SnapStop.limit(0, from: 0, areas: areas), 0)
    }
}
