// @exact/model on Apple: `exact-model`, a binary glTF (`source`) in a SceneKit view that fills its
// box, lit by directional `lights` and an image-based light (`environment`, a KTX 1 cubemap as
// Filament's cmgen writes it; a plain studio when absent). See ../README.md for every prop.
//
// - The glTF is read here (ModelGLB.swift) into SCNGeometry and physically based SCNMaterials:
//   base colour, metallic-roughness, normal, occlusion, emissive, alpha blend, a clearcoat layer
//   (KHR_materials_clearcoat), and KHR_materials_unlit as a constant material.
// - A pose prop moves the model at once, or on a critically damped spring when `response` is set;
//   `settled` runs when it arrives. `tilt` leans the model against the device's pitch and roll from
//   Core Motion (iOS), `sway` swings it gently. The numbers are ModelMotion.swift's.
// - `textures` replace the picture of named nodes, `hiddenNodes` leaves nodes out, `sheen` draws
//   moving light bands over the nodes that show a picture (a surface shader modifier).
// - A bundled `source` is read from the app's `assets` in the bundle (or EXACT_ASSETS under the
//   agent); an `app:/` path from the session's files; an http(s) URL is fetched. A file only an
//   over-the-air generation holds is not reachable from a package.
// - Light units: a light's `intensity` is irradiance in the scene's own units (white diffuse shows
//   intensity / pi); SceneKit's lumens are taken as 1000 for a radiance of 1, so a light is set at
//   intensity * 1000 / pi, and `ambient` scales the environment as it is.
import CoreMotion
import ExactPackage
import Foundation
import ImageIO
import Metal
import SceneKit
import simd
#if os(macOS)
import AppKit
#else
import UIKit
#endif

public final class ModelModule: NSObject, ExactPackage {
    let context: ExactPackageContext

    public init(context: ExactPackageContext) {
        self.context = context
        super.init()
    }

    public func later(_ name: String, _ args: [String: Any], preferred: Any?, reply: @escaping ([String: Any]) -> Void) {
        reply(["error": "NotSupportedError"])
    }

    public func view(_ tag: String, id: String, props: [String: String], events: ExactPackageEvents) throws -> ExactPackageView {
        guard tag == "exact-model" else { throw ExactPackageRefusal("no view \(tag)") }
        let view = ModelView(context: context, events: events)
        try view.setProps(props)
        return view
    }

    public func destroy(_ done: @escaping () -> Void) { done() }
}

private func json<T>(_ text: String?, as _: T.Type) -> [T] {
    guard let text, let data = text.data(using: .utf8), let any = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
    return any.compactMap { $0 as? T }
}

private func number(_ v: String?) -> Double? { v.flatMap { Double($0) }.flatMap { $0.isFinite ? $0 : nil } }

final class ModelView: NSObject, ExactPackageView, SCNSceneRendererDelegate {
    private let context: ExactPackageContext
    private let events: ExactPackageEvents
    private let scn = SCNView(frame: .zero)
    private let scene = SCNScene()
    private let camera = SCNNode()
    private let rig = SCNNode()
    private let model = SCNNode()
    private var lightNodes: [SCNNode] = []
    private var props: [String: String] = [:]
    private var pose = [Double](repeating: 0, count: 6), velocity = [Double](repeating: 0, count: 6)
    private var goal = [Double](repeating: 0, count: 6)   // yaw, pitch, roll (radians), scale, x, y
    private var response = 0.0
    private var unsettled = false
    private var tilt = ModelMotion.Tilt(), tiltMix = 0.0, tiltConfig = ModelMotion.TiltConfig()
    #if os(iOS)
    private let motion = CMMotionManager()
    #endif
    private var device: (pitch: Double, roll: Double)?
    private var swayDeg = 0.0, swayMs = 5200.0, swayFrom: TimeInterval?
    private var lastTime: TimeInterval?
    private var drawables: [(node: SCNNode, chain: [String], unlit: Bool, textured: Bool, material: SCNMaterial)] = []
    private var bounds = (half: 0.1, front: 0.0)
    private var ticket = 0
    private var loaded = false, told = false, drawnAfterLoad = 0
    private var sources = (source: "", environment: "", textures: "")
    private var doc: GLB?
    private var sheen: [(at: Double, width: Double, peak: Double)] = []
    private var lights: [(yaw: Double, pitch: Double, intensity: Double, kelvin: Double)] = []

    init(context: ExactPackageContext, events: ExactPackageEvents) {
        self.context = context
        self.events = events
        super.init()
        scn.scene = scene
        scn.delegate = self
        scn.antialiasingMode = .multisampling4X
        scn.autoenablesDefaultLighting = false
        scn.rendersContinuously = false
        scn.preferredFramesPerSecond = 60
        #if os(macOS)
        scn.backgroundColor = .clear
        scn.layer?.isOpaque = false
        #else
        scn.backgroundColor = .clear
        scn.isOpaque = false
        #endif
        scene.background.contents = nil
        let cam = SCNCamera()
        cam.projectionDirection = .vertical
        cam.zNear = 0.01; cam.zFar = 10
        cam.wantsHDR = false
        camera.camera = cam
        scene.rootNode.addChildNode(camera)
        rig.addChildNode(model)
        scene.rootNode.addChildNode(rig)
        events.intrinsicSize(nil)
    }

    var view: ExactPackagePlatformView { scn }

    func setProps(_ next: [String: String]) throws {
        let first = props.isEmpty
        let changed = { (k: String) in first || next[k] != self.props[k] }
        props = next
        if changed("source") || changed("environment") { reload(next["source"] ?? "", next["environment"]) }
        if changed("textures") || changed("hiddenNodes") || changed("sheen") { applyNodes() }
        if changed("lights") || changed("ambient") { applyLights() }
        let aim = [number(next["yaw"]) ?? 0, number(next["pitch"]) ?? 0, number(next["roll"]) ?? 0].map { $0 * ModelMotion.deg }
            + [number(next["modelScale"]) ?? 1, number(next["offsetX"]) ?? 0, number(next["offsetY"]) ?? 0]
        response = max(0, number(next["response"]) ?? 0)
        let moved = aim != goal
        goal = aim
        if response == 0 || first { pose = aim; velocity = [Double](repeating: 0, count: 6) } else if moved { unsettled = true }
        tiltMix = max(0, min(1, number(next["tilt"]) ?? 0))
        tiltConfig = ModelMotion.TiltConfig(
            gain: number(next["tiltGain"]) ?? 0.5, maxDeg: number(next["tiltMaxDeg"]) ?? 6, stiffness: number(next["tiltStiffness"]) ?? 70,
            damping: number(next["tiltDamping"]) ?? 15, recenter: number(next["tiltRecenter"]) ?? 0.02)
        swayDeg = number(next["sway"]) ?? 0
        swayMs = number(next["swayMs"]) ?? 5200
        updateTiltSensor()
        applyPose(sway: 0, leanPitch: 0, leanYaw: 0)
        updateContinuous()
    }

    func destroy() {
        ticket += 1
        #if os(iOS)
        motion.stopDeviceMotionUpdates()
        #endif
        scn.delegate = nil
        scn.isPlaying = false
    }

    // MARK: loading

    private func fail(_ message: String) { events.emit("failed", [message]) }

    private func resolve(_ path: String, then: @escaping (Result<Data, Error>) -> Void) {
        if path.hasPrefix("http://") || path.hasPrefix("https://"), let url = URL(string: path) {
            URLSession.shared.dataTask(with: url) { data, _, error in
                DispatchQueue.main.async { then(data.map { .success($0) } ?? .failure(error ?? ModelRefusal("\(path): no data"))) }
            }.resume()
            return
        }
        var roots: [URL] = []
        if path.hasPrefix("app:/") {
            if let url = context.file(path) { roots = [url] }
        } else {
            if let assets = ProcessInfo.processInfo.environment["EXACT_ASSETS"] { roots.append(URL(fileURLWithPath: assets).appendingPathComponent(path)) }
            if let resources = Bundle.main.resourcePath { roots.append(URL(fileURLWithPath: resources).appendingPathComponent(path)) }
            roots.append(Bundle.main.bundleURL.appendingPathComponent(path))
        }
        guard let url = roots.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
            then(.failure(ModelRefusal("\(path): no such file")))
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try Data(contentsOf: url) }
            DispatchQueue.main.async { then(result) }
        }
    }

    private func reload(_ source: String, _ environment: String?) {
        ticket += 1
        let mine = ticket
        loaded = false; told = false; drawnAfterLoad = 0
        guard !source.isEmpty else { fail("`source` names no model"); return }
        var glb: Data?, env: Data?, failure: Error?
        let group = DispatchGroup()
        group.enter()
        resolve(source) { r in if case .success(let d) = r { glb = d } else if case .failure(let e) = r { failure = e }; group.leave() }
        if let environment, !environment.isEmpty {
            group.enter()
            resolve(environment) { r in if case .success(let d) = r { env = d } else if case .failure(let e) = r { failure = e }; group.leave() }
        }
        group.notify(queue: .main) { [weak self] in
            guard let self, mine == self.ticket else { return }
            do {
                if let failure { throw failure }
                guard let glb else { throw ModelRefusal("no model") }
                let doc = try GLB(glb)
                try self.build(doc)
                try self.setEnvironment(env)
                self.doc = doc
                self.applyNodes()
                self.applyLights()
                self.loaded = true
                self.updateContinuous()
            } catch { self.fail("\(error)") }
        }
    }

    private func build(_ doc: GLB) throws {
        model.childNodes.forEach { $0.removeFromParentNode() }
        drawables = []
        var images: [Int: CGImage] = [:]
        func image(_ texture: Int?) -> CGImage? {
            guard let texture, let source = doc.textures[texture]["source"] as? Int else { return nil }
            if let cached = images[source] { return cached }
            guard let data = try? doc.imageData(source), let src = CGImageSourceCreateWithData(data as CFData, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
            images[source] = img
            return img
        }
        for d in doc.drawables() {
            let prim = doc.primitive(d)
            guard (prim["mode"] as? Int ?? 4) == 4, let attrs = prim["attributes"] as? [String: Int], let pos = attrs["POSITION"] else { continue }
            var sources: [SCNGeometrySource] = []
            let p = try doc.floats(pos)
            sources.append(SCNGeometrySource(vertices: stride(from: 0, to: p.values.count, by: 3).map { SCNVector3(p.values[$0], p.values[$0 + 1], p.values[$0 + 2]) }))
            if let n = attrs["NORMAL"] {
                let f = try doc.floats(n)
                sources.append(SCNGeometrySource(normals: stride(from: 0, to: f.values.count, by: 3).map { SCNVector3(f.values[$0], f.values[$0 + 1], f.values[$0 + 2]) }))
            }
            if let t = attrs["TEXCOORD_0"] {
                let f = try doc.floats(t)
                #if os(macOS)
                sources.append(SCNGeometrySource(textureCoordinates: stride(from: 0, to: f.values.count, by: 2).map { CGPoint(x: CGFloat(f.values[$0]), y: CGFloat(f.values[$0 + 1])) }))
                #else
                sources.append(SCNGeometrySource(textureCoordinates: stride(from: 0, to: f.values.count, by: 2).map { CGPoint(x: CGFloat(f.values[$0]), y: CGFloat(f.values[$0 + 1])) }))
                #endif
            }
            let indices = try (prim["indices"] as? Int).map { try doc.indices($0) } ?? (0..<UInt32(p.values.count / 3)).map { $0 }
            let element = SCNGeometryElement(indices: indices, primitiveType: .triangles)
            let geometry = SCNGeometry(sources: sources, elements: [element])

            let material = doc.materials.indices.contains(prim["material"] as? Int ?? -1) ? doc.materials[prim["material"] as! Int] : [:]
            let pbr = material["pbrMetallicRoughness"] as? [String: Any] ?? [:]
            let ext = material["extensions"] as? [String: Any] ?? [:]
            let m = SCNMaterial()
            let unlit = ext["KHR_materials_unlit"] != nil
            m.lightingModel = unlit ? .constant : .physicallyBased
            let baseFactor = (pbr["baseColorFactor"] as? [NSNumber])?.map { CGFloat($0.doubleValue) } ?? [1, 1, 1, 1]
            let baseTex = image((pbr["baseColorTexture"] as? [String: Any])?["index"] as? Int)
            if let baseTex { m.diffuse.contents = baseTex } else { m.diffuse.contents = color(baseFactor) }
            if !unlit {
                let mr = image((pbr["metallicRoughnessTexture"] as? [String: Any])?["index"] as? Int)
                if let mr { m.metalness.contents = mr; m.roughness.contents = mr }
                else { m.metalness.contents = pbr["metallicFactor"] as? NSNumber ?? 1; m.roughness.contents = pbr["roughnessFactor"] as? NSNumber ?? 1 }
                if mr != nil { m.metalness.textureComponents = .blue; m.roughness.textureComponents = .green }
                if let n = image((material["normalTexture"] as? [String: Any])?["index"] as? Int) { m.normal.contents = n }
                if let o = image((material["occlusionTexture"] as? [String: Any])?["index"] as? Int) { m.ambientOcclusion.contents = o; m.ambientOcclusion.textureComponents = .red }
                if let e = image((material["emissiveTexture"] as? [String: Any])?["index"] as? Int) { m.emission.contents = e }
                else if let f = (material["emissiveFactor"] as? [NSNumber])?.map({ CGFloat($0.doubleValue) }), f.contains(where: { $0 > 0 }) { m.emission.contents = color(f + [1]) }
                if let coat = ext["KHR_materials_clearcoat"] as? [String: Any] {
                    m.clearCoat.contents = coat["clearcoatFactor"] as? NSNumber ?? 0
                    m.clearCoatRoughness.contents = coat["clearcoatRoughnessFactor"] as? NSNumber ?? 0
                }
            }
            m.isDoubleSided = material["doubleSided"] as? Bool ?? false
            if (material["alphaMode"] as? String) == "BLEND" {
                m.blendMode = .alpha
                m.writesToDepthBuffer = false
                m.transparency = CGFloat(baseFactor.count > 3 ? baseFactor[3] : 1)
                m.transparencyMode = .aOne
            }
            geometry.materials = [m]
            let node = SCNNode(geometry: geometry)
            node.simdTransform = d.world
            node.name = d.name
            model.addChildNode(node)
            drawables.append((node, d.chain, unlit, unlit && baseTex != nil, m))
        }
        let b = doc.bounds()
        bounds = (Double(b.max.y - b.min.y) / 2, Double(b.max.z))
    }

    private func color(_ c: [CGFloat]) -> Any {
        #if os(macOS)
        return NSColor(srgbRed: c[0], green: c[1], blue: c[2], alpha: c.count > 3 ? c[3] : 1)
        #else
        return UIColor(red: c[0], green: c[1], blue: c[2], alpha: c.count > 3 ? c[3] : 1)
        #endif
    }

    // MARK: environment

    private func setEnvironment(_ data: Data?) throws {
        guard let device = MTLCreateSystemDefaultDevice() else { throw ModelRefusal("no Metal device") }
        let light = try data.map { try KTXLight($0) } ?? KTXLight.studio()
        let d = MTLTextureDescriptor.textureCubeDescriptor(pixelFormat: .rg11b10Float, size: light.size, mipmapped: light.mips.count > 1)
        d.mipmapLevelCount = light.mips.count
        guard let texture = device.makeTexture(descriptor: d) else { throw ModelRefusal("the light's texture could not be made") }
        for (level, mip) in light.mips.enumerated() {
            for (face, texels) in mip.texels.enumerated() {
                texels.withUnsafeBytes {
                    texture.replace(region: MTLRegionMake2D(0, 0, mip.size, mip.size), mipmapLevel: level, slice: face, withBytes: $0.baseAddress!, bytesPerRow: mip.size * 4, bytesPerImage: mip.size * mip.size * 4)
                }
            }
        }
        scene.lightingEnvironment.contents = texture
    }

    // MARK: lights, nodes

    private func applyLights() {
        lightNodes.forEach { $0.removeFromParentNode() }
        lightNodes = []
        scene.lightingEnvironment.intensity = CGFloat(number(props["ambient"]) ?? 0.77)
        let specs = json(props["lights"], as: [String: Any].self)
        for s in specs {
            guard let yaw = (s["yaw"] as? NSNumber)?.doubleValue, let pitch = (s["pitch"] as? NSNumber)?.doubleValue,
                  let intensity = (s["intensity"] as? NSNumber)?.doubleValue, let kelvin = (s["kelvin"] as? NSNumber)?.doubleValue else { continue }
            let light = SCNLight()
            light.type = .directional
            light.intensity = CGFloat(intensity * 1000 / Double.pi)
            light.temperature = CGFloat(kelvin)
            light.castsShadow = false
            let node = SCNNode()
            node.light = light
            let dir = ModelMotion.lightDirection(yaw: yaw, pitch: pitch)
            node.simdOrientation = simd_quatf(from: SIMD3<Float>(0, 0, -1), to: SIMD3<Float>(Float(dir[0]), Float(dir[1]), Float(dir[2])))
            scene.rootNode.addChildNode(node)
            lightNodes.append(node)
        }
    }

    private func applyNodes() {
        let hidden = Set(json(props["hiddenNodes"], as: String.self))
        let wanted = json(props["textures"], as: [String: Any].self).compactMap { t -> (String, String)? in
            guard let n = t["node"] as? String, let s = t["source"] as? String else { return nil }
            return (n, s)
        }
        sheen = json(props["sheen"], as: [String: Any].self).compactMap {
            guard let a = ($0["at"] as? NSNumber)?.doubleValue, let w = ($0["width"] as? NSNumber)?.doubleValue, let p = ($0["peak"] as? NSNumber)?.doubleValue else { return nil }
            return (a, w, p)
        }
        for d in drawables { d.node.isHidden = d.chain.contains(where: hidden.contains) }
        let key = wanted.map { "\($0.0)=\($0.1)" }.joined(separator: "|")
        if key != sources.textures {
            sources.textures = key
            for (name, path) in wanted {
                resolve(path) { [weak self] r in
                    guard let self, self.sources.textures == key else { return }
                    switch r {
                    case .failure(let e): self.fail("\(e)")
                    case .success(let data):
                        guard let src = CGImageSourceCreateWithData(data as CFData, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return self.fail("\(path): not an image") }
                        for d in self.drawables where d.chain.contains(name) { d.material.diffuse.contents = img }
                    }
                }
            }
        }
        for d in drawables where d.unlit && (d.textured || d.chain.contains(where: { n in wanted.contains { $0.0 == n } })) {
            if sheen.isEmpty { d.material.shaderModifiers = nil } else { d.material.shaderModifiers = [.surface: Self.sheenShader] }
        }
    }

    private static let sheenShader = """
    #pragma arguments
    float4 band0;
    float4 band1;
    float4 band2;
    float sheenWu;
    float sheenWeight;
    #pragma body
    float2 uv = _surface.diffuseTexcoord;
    float3 rgb = _surface.diffuse.rgb;
    float4 bands[3] = { band0, band1, band2 };
    for (int i = 0; i < 3; i++) {
        float t = (sheenWu * (uv.x + 1.0 - bands[i].z) + (1.0 - sheenWu) * (uv.y + 1.0 - bands[i].z)) / 3.0;
        float a = bands[i].y * sheenWeight * max(0.0, 1.0 - abs(t - 0.5) / (max(bands[i].x, 1e-4) * 0.5));
        rgb = mix(rgb, float3(1.0), clamp(a, 0.0, 1.0));
    }
    _surface.diffuse.rgb = rgb;
    """

    // MARK: motion

    private func updateTiltSensor() {
        #if os(iOS)
        if tiltMix > 0, motion.isDeviceMotionAvailable {
            guard !motion.isDeviceMotionActive else { return }
            motion.deviceMotionUpdateInterval = 1.0 / 60
            motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: .main) { [weak self] m, _ in
                guard let m else { return }
                self?.device = (m.attitude.pitch, m.attitude.roll)
            }
        } else {
            motion.stopDeviceMotionUpdates()
            device = nil
        }
        #endif
    }

    private func updateContinuous() {
        let animating = unsettled || swayDeg != 0 || (tiltMix > 0 && device != nil) || !told
        scn.rendersContinuously = animating && loaded
        scn.isPlaying = animating && loaded
    }

    private func applyPose(sway: Double, leanPitch: Double, leanYaw: Double) {
        let yaw = pose[0] + leanYaw + sway * swayDeg * ModelMotion.deg
        let pitch = pose[1] + leanPitch - 0.4 * sway * swayDeg * ModelMotion.deg
        let qy = simd_quatf(angle: Float(yaw), axis: SIMD3(0, 1, 0)), qx = simd_quatf(angle: Float(pitch), axis: SIMD3(1, 0, 0)), qz = simd_quatf(angle: Float(pose[2]), axis: SIMD3(0, 0, 1))
        rig.simdOrientation = qz * qx * qy
        rig.simdScale = SIMD3(repeating: Float(pose[3]))
        rig.simdPosition = SIMD3(Float(pose[4]), Float(pose[5]), 0)
        let fov = number(props["fov"]) ?? 24
        camera.camera?.fieldOfView = CGFloat(fov)
        let distance = ModelMotion.cameraDistance(distance: number(props["distance"]), fit: number(props["viewFill"]) ?? 0.74, fov: fov, half: bounds.half, front: bounds.front)
        camera.simdPosition = SIMD3(0, 0, Float(distance))
        let bands = sheen.prefix(3).map { s in
            SCNVector4(Float(s.width), Float(s.peak), Float((number(props["sheenRest"]) ?? 0) + s.at + (number(props["sheenYaw"]) ?? 0) * (yaw - goal[0]) + (number(props["sheenPitch"]) ?? 0) * (pitch - goal[1])), 0)
        }
        let wu = (420.0 * 420.0) / (420.0 * 420.0 + 912.0 * 912.0)
        for d in drawables where d.unlit && !sheen.isEmpty {
            for (i, b) in bands.enumerated() { d.material.setValue(NSValue(scnVector4: b), forKey: "band\(i)") }
            for i in bands.count..<3 { d.material.setValue(NSValue(scnVector4: SCNVector4(1, 0, 0, 0)), forKey: "band\(i)") }
            d.material.setValue(Float(wu), forKey: "sheenWu")
            d.material.setValue(Float(number(props["sheenStrength"]) ?? 1), forKey: "sheenWeight")
        }
    }

    func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
        guard loaded else { return }
        let dt = lastTime.map { min(time - $0, 0.1) } ?? 1.0 / 60
        lastTime = time
        if unsettled {
            var off = false
            for k in 0..<6 {
                (pose[k], velocity[k]) = ModelMotion.springStep(pose[k], velocity[k], goal: goal[k], responseMs: response, dt: dt)
                let limit = k < 3 ? 0.012 : k == 3 ? 0.006 : 0.0005
                if !ModelMotion.sprung(pose[k], velocity[k], goal: goal[k], responseMs: response, limit: limit) { off = true }
            }
            if !off {
                pose = goal; velocity = [Double](repeating: 0, count: 6); unsettled = false
                DispatchQueue.main.async { self.events.emit("settled", []); self.updateContinuous() }
            }
        }
        var leanPitch = 0.0, leanYaw = 0.0
        if tiltMix > 0, let device {
            ModelMotion.tiltStep(&tilt, pitch: device.pitch, roll: device.roll, dt: dt, tiltConfig)
            leanPitch = tilt.pitch * tiltMix; leanYaw = tilt.yaw * tiltMix
        } else { tilt.ready = false }
        let start = swayFrom ?? { swayFrom = time; return time }()
        let sway = swayDeg != 0 ? ModelMotion.swayAt((time - start) * 1000, periodMs: swayMs) : 0
        applyPose(sway: sway, leanPitch: leanPitch, leanYaw: leanYaw)
    }

    func renderer(_ renderer: SCNSceneRenderer, didRenderScene scene: SCNScene, atTime time: TimeInterval) {
        guard loaded, !told else { return }
        drawnAfterLoad += 1
        if drawnAfterLoad >= 2 {
            told = true
            DispatchQueue.main.async { self.events.load(); self.updateContinuous() }
        }
    }
}
