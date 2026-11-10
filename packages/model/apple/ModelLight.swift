// An image-based light as Filament's cmgen writes it: a KTX 1 cubemap of R11G11B10F texels, its mips
// prefiltered by roughness. SceneKit filters and integrates the cubemap itself, so the file's sh
// entry is not read here (the web reads it). Foundation only.
import Foundation

struct KTXLight {
    struct Mip { let size: Int; let texels: [Data] }
    let size: Int
    let mips: [Mip]

    init(_ data: Data) throws {
        func u32(_ at: Int) -> Int { Int(data[at]) | Int(data[at + 1]) << 8 | Int(data[at + 2]) << 16 | Int(data[at + 3]) << 24 }
        let ident: [UInt8] = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]
        guard data.count >= 64, Array(data.prefix(12)) == ident else { throw ModelRefusal("not a KTX 1 file") }
        guard u32(12) == 0x04030201 else { throw ModelRefusal("a big-endian KTX is not read") }
        guard u32(28) == 35898 else { throw ModelRefusal("a KTX of format \(u32(28)) is not read: the light is R11G11B10F") }
        let width = u32(36), faces = u32(52), levels = max(1, u32(56)), keyBytes = u32(60)
        guard faces == 6, width == u32(40) else { throw ModelRefusal("the light is a cubemap") }
        var at = 64 + keyBytes
        var mips: [Mip] = []
        for level in 0..<levels {
            guard at + 4 <= data.count else { throw ModelRefusal("the light's mips are cut short") }
            let n = u32(at)
            at += 4
            var texels: [Data] = []
            for _ in 0..<6 {
                guard at + n <= data.count else { throw ModelRefusal("the light's faces are cut short") }
                texels.append(data.subdata(in: at..<(at + n)))
                at += (n + 3) & ~3
            }
            mips.append(Mip(size: max(1, width >> level), texels: texels))
        }
        size = width
        self.mips = mips
    }

    private init(size: Int, mips: [Mip]) { self.size = size; self.mips = mips }

    /// A plain studio when the app names no light: a grey room with a brighter sky and a soft window.
    static func studio(size: Int = 32) -> KTXLight {
        func face(_ f: Int, _ u: Double, _ v: Double) -> [Double] {
            [[1, -v, -u], [-1, -v, u], [u, 1, v], [u, -1, -v], [u, -v, 1], [-u, -v, -1]][f]
        }
        func smooth(_ x: Double) -> Double { x * x * (3 - 2 * x) }
        func radiance(_ d: [Double]) -> Double {
            let l = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).squareRoot()
            let x = d[0] / l, y = d[1] / l, z = d[2] / l
            let base = 0.45 + 0.55 * (0.5 + 0.5 * y)
            var window = 0.0
            if z > 0.2 {
                let u = x * 0.5 / z + 0.5, v = 0.5 - y * 0.5 / z
                let edge = { (a: Double, lo: Double, hi: Double) in smooth(min(1, max(0, (min(a - lo, hi - a) + 0.04) / 0.08))) }
                window = edge(u, 0.3, 0.7) * edge(v, 0.25, 0.65)
            }
            return base + 8 * window
        }
        let levels = Int(log2(Double(size))) - 1
        var mips: [Mip] = []
        var n = size
        for level in 0..<levels {
            var faces: [Data] = []
            for f in 0..<6 {
                var texels = [UInt32](repeating: 0, count: n * n)
                for j in 0..<n { for i in 0..<n {
                    let r = radiance(face(f, 2 * (Double(i) + 0.5) / Double(n) - 1, 2 * (Double(j) + 0.5) / Double(n) - 1))
                    let blur = Double(level) / Double(levels)
                    let v = r + (0.9 - r) * blur * 0.8
                    texels[j * n + i] = packR11G11B10(v, v, v)
                } }
                faces.append(texels.withUnsafeBytes { Data($0) })
            }
            mips.append(Mip(size: n, texels: faces))
            n >>= 1
        }
        return KTXLight(size: size, mips: mips)
    }
}

/// An unsigned float of `eb` exponent and `mb` mantissa bits, as R11G11B10F holds each channel.
func packFloat(_ value: Double, _ eb: Int, _ mb: Int) -> UInt32 {
    guard value > 0 else { return 0 }
    let bits = Float(value).bitPattern
    let bias = (1 << (eb - 1)) - 1, maxExponent = (1 << eb) - 2
    let e = Int((bits >> 23) & 0xff) - 127 + bias
    if e > maxExponent { return UInt32((maxExponent << mb) | ((1 << mb) - 1)) }
    if e <= 0 { return 0 }
    return UInt32((e << mb)) | ((bits & 0x7fffff) >> UInt32(23 - mb))
}

func packR11G11B10(_ r: Double, _ g: Double, _ b: Double) -> UInt32 {
    packFloat(r, 5, 6) | (packFloat(g, 5, 6) << 11) | (packFloat(b, 5, 5) << 22)
}
