import CoreGraphics

enum ImageInk {
    static let maxSide = 150
    static let ink: UInt8 = 24, solid: UInt8 = 128
    static let footRow = 0.98

    static func payload(_ image: CGImage, natural: CGSize) -> String {
        let fields = [Double(natural.width), Double(natural.height)] + (measure(image) ?? Array(repeating: 0, count: 8))
        return fields.map { $0 == $0.rounded() ? String(Int($0)) : String($0) }.joined(separator: ",")
    }

    static func measure(_ image: CGImage) -> [Double]? {
        let k = min(1, Double(maxSide) / Double(max(image.width, image.height, 1)))
        let w = max(1, Int((Double(image.width) * k).rounded())), h = max(1, Int((Double(image.height) * k).rounded()))
        var alpha = [UInt8](repeating: 0, count: w * h)
        let drawn = alpha.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                          space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue) else { return false }
            context.interpolationQuality = .none
            context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return nil }
        let a = { (x: Int, y: Int) in alpha[y * w + x] }
        var x0 = w, y0 = h, x1 = -1, y1 = -1
        var rows: [(y: Int, first: Int, last: Int)] = []
        for y in 0..<h {
            var first = -1, last = -1
            for x in 0..<w where a(x, y) >= ink { if first < 0 { first = x }; last = x }
            guard first >= 0 else { continue }
            rows.append((y, first, last))
            x0 = min(x0, first); x1 = max(x1, last); y0 = min(y0, y); y1 = max(y1, y)
        }
        guard x1 >= 0 else { return nil }
        let r4 = { (n: Double) in (n * 10000).rounded() / 10000 }, r3 = { (n: Double) in (n * 1000).rounded() / 1000 }
        var points: [(Double, Double)] = []
        for row in rows {
            let (y, l, r) = (Double(row.y), Double(row.first), Double(row.last + 1))
            points += [(l, y), (r, y), (l, y + 1), (r, y + 1)]
        }
        let boxArea = Double((x1 + 1 - x0) * (y1 + 1 - y0)), hull = hullArea(points)
        let fill = boxArea > 0 && hull > 0 ? r3(min(1, hull / boxArea)) : 1
        var solidTop = 0.0, footLeft = 0.0, footRight = 0.0
        if let top = (0..<h).first(where: { y in (0..<w).contains { a($0, y) > solid } }) {
            solidTop = Double(top) / Double(h)
            let row = min(h - 1, Int((Double(h) * footRow).rounded()))
            let xs = (0..<w).filter { a($0, row) > solid }
            if let l = xs.first, let r = xs.last { footLeft = Double(l) / Double(w); footRight = Double(r + 1) / Double(w) }
        }
        return [r4(Double(x0) / Double(w)), r4(Double(y0) / Double(h)), r4(min(1, Double(x1 + 1) / Double(w))),
                r4(min(1, Double(y1 + 1) / Double(h))), fill, r4(solidTop), r4(footLeft), r4(footRight)]
    }

    static func hullArea(_ points: [(Double, Double)]) -> Double {
        guard points.count >= 3 else { return 0 }
        let sorted = points.sorted { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }
        func cross(_ o: (Double, Double), _ p: (Double, Double), _ q: (Double, Double)) -> Double {
            (p.0 - o.0) * (q.1 - o.1) - (p.1 - o.1) * (q.0 - o.0)
        }
        var lower: [(Double, Double)] = [], upper: [(Double, Double)] = []
        for p in sorted { while lower.count >= 2, cross(lower[lower.count - 2], lower[lower.count - 1], p) <= 0 { lower.removeLast() }; lower.append(p) }
        for p in sorted.reversed() { while upper.count >= 2, cross(upper[upper.count - 2], upper[upper.count - 1], p) <= 0 { upper.removeLast() }; upper.append(p) }
        let hull = Array(lower.dropLast()) + Array(upper.dropLast())
        var twice = 0.0
        for i in hull.indices { let (a, b) = (hull[i], hull[(i + 1) % hull.count]); twice += a.0 * b.1 - b.0 * a.1 }
        return abs(twice) / 2
    }
}
