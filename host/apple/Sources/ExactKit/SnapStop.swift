import Foundation

/// CSS `scroll-snap-stop: always`: a snap position the scroll may not pass.
struct SnapArea {
    var start: Double
    var end: Double
    var stops: Bool
}

enum SnapStop {
    /// `target` limited to the nearest stopping area between `origin` and it.
    static func limit(_ target: Double, from origin: Double, areas: [SnapArea]) -> Double {
        if target > origin + 0.5 {
            let blockers = areas.filter { $0.stops && $0.start > origin + 0.5 && $0.start < target - 0.5 }
            return blockers.map(\.start).min() ?? target
        }
        if target < origin - 0.5 {
            let blockers = areas.filter { $0.stops && $0.end < origin - 0.5 && $0.end > target + 0.5 }
            return blockers.map(\.end).max() ?? target
        }
        return target
    }
}
