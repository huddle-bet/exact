// Prints what Model*.swift computes for fixed inputs, as JSON, for web/apple.test.mjs to compare with
// web/motion.js. Built with ModelMotion.swift, ModelGLB.swift and ModelLight.swift:
// usage: logic <glb> <ktx>
import Foundation

var out: [String: Any] = [:]
out["light"] = ModelMotion.lightDirection(yaw: -34.7, pitch: 18)
out["kelvin"] = ModelMotion.kelvinToLinear(5500)
var x = 0.0, v = 0.0
for _ in 0..<10 { (x, v) = ModelMotion.springStep(x, v, goal: 1, responseMs: 850, dt: 1.0 / 60) }
out["spring"] = [x, v]
var tilt = ModelMotion.Tilt()
for i in 0..<20 { ModelMotion.tiltStep(&tilt, pitch: 1.2 + Double(i) * 0.01, roll: 0.05 * Double(i), dt: 1.0 / 60) }
out["tilt"] = [tilt.pitch, tilt.yaw, tilt.vPitch, tilt.vYaw]
out["sway"] = [ModelMotion.swayAt(600, periodMs: 5200), ModelMotion.swayAt(3000, periodMs: 5200)]
out["distance"] = [
    ModelMotion.cameraDistance(distance: nil, fit: 0.74, fov: 24, half: 0.0783, front: 0.00566),
    ModelMotion.cameraDistance(distance: 0.5, fit: 0.74, fov: 24, half: 0.0783, front: 0.00566),
]
out["sheen"] = [ModelMotion.sheenCoord(u: 0.3, v: 0.6, along: -0.6, w: 420, h: 912), ModelMotion.sheenAlpha(0.52, width: 0.12, peak: 0.06)]
out["pack"] = [packR11G11B10(0.5, 1, 2), packR11G11B10(0, 0, 0), packR11G11B10(60000, 1, 1)].map { Int($0) }
let rect = ModelMotion.Rect(c: [-0.0028, 0, 0.00566], hw: 0.03482, hh: 0.07573)
let placed = ModelMotion.screenPlacement(
    pose: ModelMotion.poseMatrix(pitch: -0.05, yaw: 0.28, roll: 0.1, scale: 0.99, x: 0.004, y: -0.01), rect: rect, fov: 24, distance: 0.503, viewW: 420, viewH: 700, w: 420)
out["placement"] = placed.json
out["lean"] = ModelMotion.leanGoal([0.2, 0, 0, 1, 0, 0], [-0.4, -0.1, 0, 0.6, 0.01, 0], 0.5)
let args = CommandLine.arguments
if args.count > 1 {
    let glb = try GLB(try Data(contentsOf: URL(fileURLWithPath: args[1])))
    let d = glb.drawables()
    let b = glb.bounds()
    let p = try glb.floats(((glb.primitive(d[0])["attributes"] as! [String: Int])["POSITION"])!)
    if let r = glb.rectOf("tppzCQmnlKcHIpP") { out["rect"] = [r.c[0], r.c[1], r.c[2], r.hw, r.hh] }
    out["glb"] = ["drawables": d.count, "min": [b.min.x, b.min.y, b.min.z], "max": [b.max.x, b.max.y, b.max.z], "chain": d.last!.chain, "firstVertex": Array(p.values.prefix(3))]
}
if args.count > 2 {
    let k = try KTXLight(try Data(contentsOf: URL(fileURLWithPath: args[2])))
    out["ktx"] = ["size": k.size, "levels": k.mips.count, "sizes": k.mips.map { $0.size }, "firstTexel": k.mips[0].texels[0].prefix(4).map { Int($0) }]
}
let studio = KTXLight.studio()
out["studio"] = ["size": studio.size, "levels": studio.mips.count]
print(String(data: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
