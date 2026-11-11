import Foundation

enum ModelMotion {
    static let deg = Double.pi / 180

    static func lightDirection(yaw: Double, pitch: Double) -> [Double] {
        let cp = cos(pitch * deg)
        return [-cp * sin(yaw * deg), -sin(pitch * deg), -cp * cos(yaw * deg)]
    }

    static func kelvinToLinear(_ kelvin: Double) -> [Double] {
        let t = kelvin / 100
        func ch(_ v: Double) -> Double { max(0, min(255, v)) / 255 }
        let r = t <= 66 ? 1 : ch(329.698727446 * pow(t - 60, -0.1332047592))
        let g = t <= 66 ? ch(99.4708025861 * log(t) - 161.1195681661) : ch(288.1221695283 * pow(t - 60, -0.0755148492))
        let b = t >= 66 ? 1 : t <= 19 ? 0 : ch(138.5177312231 * log(t - 10) - 305.0447927307)
        func lin(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return [lin(r), lin(g), lin(b)]
    }

    static func springStep(_ x: Double, _ v: Double, goal: Double, responseMs: Double, dt: Double) -> (Double, Double) {
        let w = 2 * Double.pi / max(responseMs / 1000, 0.05)
        let decay = exp(-w * dt)
        let e = x - goal
        let k = (v + w * e) * dt
        return (goal + (e + k) * decay, (v - w * k) * decay)
    }

    static func sprung(_ x: Double, _ v: Double, goal: Double, responseMs: Double, limit: Double) -> Bool {
        let w = 2 * Double.pi / max(responseMs / 1000, 0.05)
        return abs(x - goal) <= limit && abs(v) <= limit * w
    }

    static func swayAt(_ t: Double, periodMs: Double) -> Double {
        guard periodMs > 0, t > 0 else { return 0 }
        let half = periodMs / 2
        if t < half / 2 { return (1 - cos(Double.pi * t / (half / 2))) / 2 }
        return cos(2 * Double.pi * (t - half / 2) / periodMs)
    }

    struct TiltConfig {
        var gain = 0.5, maxDeg = 6.0, stiffness = 70.0, damping = 15.0, recenter = 0.02
    }

    struct Tilt {
        var ready = false
        var basePitch = 0.0, baseRoll = 0.0
        var pitch = 0.0, yaw = 0.0, vPitch = 0.0, vYaw = 0.0
    }

    static func tiltStep(_ s: inout Tilt, pitch: Double, roll: Double, dt: Double, _ c: TiltConfig = TiltConfig()) {
        if !s.ready { s.ready = true; s.basePitch = pitch; s.baseRoll = roll }
        s.basePitch += (pitch - s.basePitch) * c.recenter
        s.baseRoll += (roll - s.baseRoll) * c.recenter
        let mx = c.maxDeg * deg
        let toPitch = max(-mx, min(mx, -(pitch - s.basePitch) * c.gain))
        let toYaw = max(-mx, min(mx, -(roll - s.baseRoll) * c.gain))
        let h = min(dt, 0.05)
        s.vPitch += (c.stiffness * (toPitch - s.pitch) - c.damping * s.vPitch) * h
        s.vYaw += (c.stiffness * (toYaw - s.yaw) - c.damping * s.vYaw) * h
        s.pitch += s.vPitch * h
        s.yaw += s.vYaw * h
    }

    static func cameraDistance(distance: Double?, fit: Double, fov: Double, half: Double, front: Double) -> Double {
        if let d = distance, d > 0 { return d }
        return front + half / (fit * tan(fov * deg / 2))
    }

    static func sheenCoord(u: Double, v: Double, along: Double, w: Double, h: Double) -> Double {
        let wu = w * w / (w * w + h * h)
        return (wu * (u + 1 - along) + (1 - wu) * (v + 1 - along)) / 3
    }

    static func sheenAlpha(_ t: Double, width: Double, peak: Double) -> Double {
        peak * max(0, 1 - abs(t - 0.5) / (width / 2))
    }

    static let leanTighten = 3.0

    static func leanGoal(_ goal: [Double], _ toward: [Double]?, _ t: Double) -> [Double] {
        let k = max(0, min(1, t))
        return goal.indices.map { goal[$0] + ((toward?[$0] ?? goal[$0]) - goal[$0]) * k }
    }

    static func leanResponse(_ response: Double, _ t: Double) -> Double { t > 0 ? response / leanTighten : response }

    static func poseMatrix(pitch: Double, yaw: Double, roll: Double, scale s: Double, x: Double, y: Double) -> [Double] {
        let (cy, sy, cp, sp, cr, sr) = (cos(yaw), sin(yaw), cos(pitch), sin(pitch), cos(roll), sin(roll))
        let a = [cy, sp * sy, -cp * sy, 0, 0, cp, sp, 0, sy, -sp * cy, cp * cy, 0]
        var out = [Double](repeating: 0, count: 16)
        for c in 0..<3 {
            let (px, py, pz) = (a[c * 4], a[c * 4 + 1], a[c * 4 + 2])
            out[c * 4] = (cr * px - sr * py) * s
            out[c * 4 + 1] = (sr * px + cr * py) * s
            out[c * 4 + 2] = pz * s
        }
        out[12] = x; out[13] = y; out[15] = 1
        return out
    }

    static func axisAngle(_ m: [Double]) -> (axis: [Double], deg: Double) {
        let tr = m[0] + m[4] + m[8]
        let angle = acos(max(-1, min(1, (tr - 1) / 2)))
        if angle < 1e-9 { return ([0, 0, 1], 0) }
        var axis: [Double]
        if Double.pi - angle < 1e-6 {
            let i = [m[0], m[4], m[8]].firstIndex(of: max(m[0], m[4], m[8]))!
            var col = [m[i], m[3 + i], m[6 + i]]
            col[i] += 1
            let n = (col[0] * col[0] + col[1] * col[1] + col[2] * col[2]).squareRoot()
            axis = col.map { $0 / n }
        } else {
            let v = [m[7] - m[5], m[2] - m[6], m[3] - m[1]]
            let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).squareRoot()
            axis = v.map { $0 / n }
        }
        return (axis, angle / deg)
    }

    struct Rect { var c: [Double]; var hw: Double; var hh: Double }

    struct Placement: Equatable {
        var perspective: Double, translate: String, rotate: String, scale: Double, facing: Bool, quad: [Double]
        var json: [String: Any] { ["perspective": perspective, "translate": translate, "rotate": rotate, "scale": scale, "facing": facing, "quad": quad] }
    }

    static func screenPlacement(pose: [Double], rect: Rect, fov: Double, distance: Double, viewW: Double, viewH: Double, w: Double) -> Placement {
        func at(_ x: Double, _ y: Double, _ z: Double) -> [Double] { (0..<3).map { pose[$0] * x + pose[4 + $0] * y + pose[8 + $0] * z + pose[12 + $0] } }
        let s = (pose[0] * pose[0] + pose[1] * pose[1] + pose[2] * pose[2]).squareRoot()
        let c = at(rect.c[0], rect.c[1], rect.c[2])
        let f = viewH / 2 / tan(fov * deg / 2)
        let k = f / (distance - c[2])
        let flip: [Double] = [1, -1, 1, -1, 1, -1, 1, -1, 1]
        var rc = [Double](repeating: 0, count: 9)
        for row in 0..<3 { for col in 0..<3 { rc[row * 3 + col] = pose[col * 4 + row] / s * flip[row * 3 + col] } }
        let (axis, angle) = axisAngle(rc)
        func project(_ p: [Double]) -> [Double] { [viewW / 2 + p[0] * f / (distance - p[2]), viewH / 2 - p[1] * f / (distance - p[2])] }
        let corners = [(-rect.hw, rect.hh), (rect.hw, rect.hh), (rect.hw, -rect.hh), (-rect.hw, -rect.hh)]
        let quad = corners.flatMap { project(at(rect.c[0] + $0.0, rect.c[1] + $0.1, rect.c[2])) }
        let normal = [pose[8] / s, pose[9] / s, pose[10] / s]
        let facing = normal[0] * -c[0] + normal[1] * -c[1] + normal[2] * (distance - c[2]) > 0
        func n(_ v: Double) -> Double { (v * 1e4).rounded() / 1e4 }
        func text(_ v: Double, _ places: Int) -> String {
            var t = String(format: "%.\(places)f", v)
            while t.contains("."), t.hasSuffix("0") { t.removeLast() }
            if t.hasSuffix(".") { t.removeLast() }
            return t == "-0" ? "0" : t
        }
        return Placement(
            perspective: n(f), translate: "\(text(c[0] * k, 4))px \(text(-c[1] * k, 4))px 0px",
            rotate: "\(axis.map { text($0, 6) }.joined(separator: " ")) \(text(angle, 6))deg",
            scale: s * 2 * rect.hw * k / w, facing: facing, quad: quad.map(n))
    }
}
