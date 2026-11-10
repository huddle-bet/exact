// A binary glTF 2.0 file read into plain arrays, as web/glb.js reads it: the scene's mesh
// primitives with their world matrices, accessors as packed arrays, embedded images as bytes. No
// skins, morphs, animations or sparse accessors.
import Foundation
import simd

struct ModelRefusal: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}

struct GLB {
    let json: [String: Any]
    let bin: Data

    init(_ data: Data) throws {
        func u32(_ at: Int) -> Int { Int(data[at]) | Int(data[at + 1]) << 8 | Int(data[at + 2]) << 16 | Int(data[at + 3]) << 24 }
        guard data.count >= 20, u32(0) == 0x46546c67 else { throw ModelRefusal("not a binary glTF (glb) file") }
        guard u32(4) == 2 else { throw ModelRefusal("only glTF 2.0 is read") }
        var parsed: [String: Any]?
        var body = Data()
        var at = 12
        while at + 8 <= data.count {
            let length = u32(at), type = u32(at + 4)
            let chunk = data.subdata(in: (at + 8)..<min(data.count, at + 8 + length))
            if type == 0x4e4f534a { parsed = try JSONSerialization.jsonObject(with: chunk) as? [String: Any] }
            else if type == 0x004e4942, body.isEmpty { body = chunk }
            at += 8 + length + (4 - length % 4) % 4
        }
        guard let parsed else { throw ModelRefusal("the glb has no JSON chunk") }
        json = parsed; bin = body
    }

    private func array(_ key: String) -> [[String: Any]] { json[key] as? [[String: Any]] ?? [] }
    var nodes: [[String: Any]] { array("nodes") }
    var meshes: [[String: Any]] { array("meshes") }
    var materials: [[String: Any]] { array("materials") }
    var textures: [[String: Any]] { array("textures") }
    var images: [[String: Any]] { array("images") }
    var accessors: [[String: Any]] { array("accessors") }
    var samplers: [[String: Any]] { array("samplers") }

    /// Accessor `index` as packed floats (a normalized or integer type converted).
    func floats(_ index: Int) throws -> (values: [Float], width: Int) {
        let a = accessors[index]
        guard a["sparse"] == nil else { throw ModelRefusal("a sparse accessor is not read") }
        let width = ["SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4][a["type"] as? String ?? ""] ?? 1
        let count = a["count"] as? Int ?? 0
        guard (a["componentType"] as? Int) == 5126 else { throw ModelRefusal("an attribute that is not float32 is not read") }
        var out = [Float](repeating: 0, count: count * width)
        guard let view = a["bufferView"] as? Int else { return (out, width) }
        let bv = array("bufferViews")[view]
        let start = (bv["byteOffset"] as? Int ?? 0) + (a["byteOffset"] as? Int ?? 0)
        let size = 4 * width, stride = (bv["byteStride"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? size
        bin.withUnsafeBytes { raw in
            for i in 0..<count {
                for k in 0..<width {
                    out[i * width + k] = raw.loadUnaligned(fromByteOffset: start + i * stride + 4 * k, as: Float.self)
                }
            }
        }
        return (out, width)
    }

    /// Accessor `index` as indices.
    func indices(_ index: Int) throws -> [UInt32] {
        let a = accessors[index]
        let count = a["count"] as? Int ?? 0
        guard let view = a["bufferView"] as? Int else { return [UInt32](repeating: 0, count: count) }
        let bv = array("bufferViews")[view]
        let start = (bv["byteOffset"] as? Int ?? 0) + (a["byteOffset"] as? Int ?? 0)
        let kind = a["componentType"] as? Int ?? 0
        let size = kind == 5125 ? 4 : kind == 5123 ? 2 : 1
        let stride = (bv["byteStride"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? size
        var out = [UInt32](repeating: 0, count: count)
        bin.withUnsafeBytes { raw in
            for i in 0..<count {
                let at = start + i * stride
                switch size {
                case 4: out[i] = raw.loadUnaligned(fromByteOffset: at, as: UInt32.self)
                case 2: out[i] = UInt32(raw.loadUnaligned(fromByteOffset: at, as: UInt16.self))
                default: out[i] = UInt32(raw.load(fromByteOffset: at, as: UInt8.self))
                }
            }
        }
        return out
    }

    /// The bytes of image `index`.
    func imageData(_ index: Int) throws -> Data {
        guard let view = images[index]["bufferView"] as? Int else { throw ModelRefusal("an image that is a uri is not read") }
        let bv = array("bufferViews")[view]
        let start = bv["byteOffset"] as? Int ?? 0
        return bin.subdata(in: start..<(start + (bv["byteLength"] as? Int ?? 0)))
    }

    struct Drawable {
        let node: Int, mesh: Int, primitive: Int
        let name: String
        let chain: [String]
        let world: simd_float4x4
    }

    private static func local(_ n: [String: Any]) -> simd_float4x4 {
        func nums(_ key: String) -> [Float]? { (n[key] as? [Any])?.compactMap { ($0 as? NSNumber)?.floatValue } }
        if let m = nums("matrix"), m.count == 16 {
            return simd_float4x4(columns: (SIMD4(m[0], m[1], m[2], m[3]), SIMD4(m[4], m[5], m[6], m[7]), SIMD4(m[8], m[9], m[10], m[11]), SIMD4(m[12], m[13], m[14], m[15])))
        }
        let t = nums("translation") ?? [0, 0, 0], q = nums("rotation") ?? [0, 0, 0, 1], s = nums("scale") ?? [1, 1, 1]
        let rot = simd_float4x4(simd_quatf(ix: q[0], iy: q[1], iz: q[2], r: q[3]))
        var scale = matrix_identity_float4x4
        scale.columns.0.x = s[0]; scale.columns.1.y = s[1]; scale.columns.2.z = s[2]
        var move = matrix_identity_float4x4
        move.columns.3 = SIMD4(t[0], t[1], t[2], 1)
        return move * rot * scale
    }

    /// Every mesh primitive of the default scene.
    func drawables() -> [Drawable] {
        var out: [Drawable] = []
        func walk(_ index: Int, _ parent: simd_float4x4, _ names: [String]) {
            let n = nodes[index]
            let world = parent * GLB.local(n)
            let name = n["name"] as? String
            let chain = name.map { names + [$0] } ?? names
            if let mesh = n["mesh"] as? Int {
                for p in 0..<((meshes[mesh]["primitives"] as? [[String: Any]])?.count ?? 0) {
                    out.append(Drawable(node: index, mesh: mesh, primitive: p, name: name ?? "", chain: chain, world: world))
                }
            }
            for child in n["children"] as? [Int] ?? [] { walk(child, world, chain) }
        }
        let scenes = array("scenes")
        let scene = scenes.indices.contains(json["scene"] as? Int ?? 0) ? scenes[json["scene"] as? Int ?? 0] : [:]
        for root in scene["nodes"] as? [Int] ?? [] { walk(root, matrix_identity_float4x4, []) }
        return out
    }

    func primitive(_ d: Drawable) -> [String: Any] {
        (meshes[d.mesh]["primitives"] as? [[String: Any]] ?? [])[d.primitive]
    }

    /// The scene's bounds after the nodes' transforms, from the accessors' bounding boxes.
    func bounds() -> (min: SIMD3<Float>, max: SIMD3<Float>) {
        var lo = SIMD3<Float>(repeating: .infinity), hi = SIMD3<Float>(repeating: -.infinity)
        for d in drawables() {
            guard let pos = (primitive(d)["attributes"] as? [String: Int])?["POSITION"] else { continue }
            let a = accessors[pos]
            guard let mn = (a["min"] as? [NSNumber])?.map(\.floatValue), let mx = (a["max"] as? [NSNumber])?.map(\.floatValue), mn.count == 3, mx.count == 3 else { continue }
            for corner in 0..<8 {
                let p = SIMD4<Float>(corner & 1 != 0 ? mx[0] : mn[0], corner & 2 != 0 ? mx[1] : mn[1], corner & 4 != 0 ? mx[2] : mn[2], 1)
                let w = d.world * p
                lo = simd_min(lo, SIMD3(w.x, w.y, w.z)); hi = simd_max(hi, SIMD3(w.x, w.y, w.z))
            }
        }
        return (lo, hi)
    }
}
