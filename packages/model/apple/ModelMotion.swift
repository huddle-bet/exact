// The numbers `exact-model` moves by, the same as web/motion.js (their tests name one set of values).
// Foundation only, so the logic compiles and runs without a view.
import Foundation

enum ModelMotion {
    static let deg = Double.pi / 180

    /// The direction a light travels for a yaw and pitch in degrees: yaw turns about +y from -z, a
    /// positive pitch aims the light down.
    static func lightDirection(yaw: Double, pitch: Double) -> [Double] {
        let cp = cos(pitch * deg)
        return [-cp * sin(yaw * deg), -sin(pitch * deg), -cp * cos(yaw * deg)]
    }

    /// A black body's colour at `kelvin` in linear sRGB.
    static func kelvinToLinear(_ kelvin: Double) -> [Double] {
        let t = kelvin / 100
        func ch(_ v: Double) -> Double { max(0, min(255, v)) / 255 }
        let r = t <= 66 ? 1 : ch(329.698727446 * pow(t - 60, -0.1332047592))
        let g = t <= 66 ? ch(99.4708025861 * log(t) - 161.1195681661) : ch(288.1221695283 * pow(t - 60, -0.0755148492))
        let b = t >= 66 ? 1 : t <= 19 ? 0 : ch(138.5177312231 * log(t - 10) - 305.0447927307)
        func lin(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return [lin(r), lin(g), lin(b)]
    }

    /// One step of a critically damped spring, in closed form: it settles in about `responseMs`.
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

    /// The idle sway, -1 to 1: it rises to 1 in a quarter of the period, then swings with it.
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

    /// One step of the device tilt from the device's `pitch` and `roll` (radians, `CMAttitude`'s).
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

    /// The camera's distance from the origin: an authored `distance` wins; else the bounds (`half`
    /// the half height, `front` the nearest z) take `fit` of the view's height.
    static func cameraDistance(distance: Double?, fit: Double, fov: Double, half: Double, front: Double) -> Double {
        if let d = distance, d > 0 { return d }
        return front + half / (fit * tan(fov * deg / 2))
    }

    /// The sheen's gradient coordinate for a screen point after the band moved `along`.
    static func sheenCoord(u: Double, v: Double, along: Double, w: Double, h: Double) -> Double {
        let wu = w * w / (w * w + h * h)
        return (wu * (u + 1 - along) + (1 - wu) * (v + 1 - along)) / 3
    }

    static func sheenAlpha(_ t: Double, width: Double, peak: Double) -> Double {
        peak * max(0, 1 - abs(t - 0.5) / (width / 2))
    }
}
