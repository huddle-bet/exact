import Foundation

struct ShaderRefusal: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

enum ShaderSkSL {
    struct Declared {
        var shaders: [String] = []
        var floats: [(name: String, size: Int)] = []
        var body = ""
    }

    private static let sizes: [String: Int] = ["float": 1, "float2": 2, "float3": 3, "float4": 4, "half": 1, "half2": 2, "half3": 3, "half4": 4]

    private static func replace(_ pattern: String, in text: String, with template: String, options: NSRegularExpression.Options = []) -> String {
        let regex = try! NSRegularExpression(pattern: pattern, options: options)
        return regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    static func parse(_ source: String) throws -> Declared {
        var text = replace("/\\*[\\s\\S]*?\\*/", in: source, with: " ")
        text = replace("//[^\\n]*", in: text, with: "")
        var declared = Declared()
        let line = try! NSRegularExpression(pattern: "^[ \\t]*uniform[ \\t]+(\\w+)[ \\t]+(\\w+)[ \\t]*;[ \\t]*$", options: .anchorsMatchLines)
        let ns = text as NSString
        var body = ""
        var at = 0
        for m in line.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            body += ns.substring(with: NSRange(location: at, length: m.range.location - at))
            at = m.range.location + m.range.length
            let type = ns.substring(with: m.range(at: 1)), name = ns.substring(with: m.range(at: 2))
            if declared.shaders.contains(name) || declared.floats.contains(where: { $0.name == name }) { throw ShaderRefusal("uniform `\(name)` is declared twice") }
            if type == "shader" { declared.shaders.append(name) }
            else if let size = sizes[type] { declared.floats.append((name, size)) }
            else { throw ShaderRefusal("uniform `\(name)` has type `\(type)`; exact-shader takes shader, float, float2..4 and half, half2..4") }
        }
        body += ns.substring(from: at)
        if body.range(of: "\\buniform\\b", options: .regularExpression) != nil { throw ShaderRefusal("a uniform is declared one to a line, as `uniform float2 center;`") }
        if body.range(of: "\\b(half4|float4)\\s+main\\s*\\(\\s*float2\\s+\\w+\\s*\\)", options: .regularExpression) == nil { throw ShaderRefusal("the source needs `half4 main(float2 p)`") }
        declared.body = body
        return declared
    }

    static func toMSL(_ source: String) throws -> (code: String, declared: Declared) {
        let d = try parse(source)
        let body = replace("\\bmain\\b", in: d.body, with: "exact_main")
        var members = d.shaders.map { "  ExactImage \($0);" }
        members += d.floats.map { "  \($0.size == 1 ? "float" : "float\($0.size)") \($0.name);" }
        var args = ""
        var fill = ""
        var at = 4
        for (unit, name) in d.shaders.enumerated() {
            args += ",\n  texture2d<float> tex\(unit) [[texture(\(unit))]]"
            fill += "  s.\(name).t = tex\(unit); s.\(name).m = float4(v[\(at)], v[\(at + 1)], v[\(at + 2)], v[\(at + 3)]); s.\(name).tile = v[\(at + 4)];\n"
            at += 5
        }
        for f in d.floats {
            let parts = (0..<f.size).map { "v[\(at + $0)]" }.joined(separator: ", ")
            fill += "  s.\(f.name) = \(f.size == 1 ? parts : "float\(f.size)(\(parts))");\n"
            at += f.size
        }
        let code = """
        #include <metal_stdlib>
        using namespace metal;
        #define half float
        #define half2 float2
        #define half3 float3
        #define half4 float4
        struct ExactImage {
          texture2d<float> t;
          float4 m;
          float tile;
          float4 texel(int2 c, int2 n) const {
            if (tile > 0.5) return t.read(uint2(clamp(c, int2(0), n - 1)));
            if (c.x < 0 || c.y < 0 || c.x >= n.x || c.y >= n.y) return float4(0.0);
            return t.read(uint2(c));
          }
          float4 eval(float2 p) const {
            int2 n = int2(t.get_width(), t.get_height());
            float2 q = (p * m.xy + m.zw) * float2(n) - 0.5;
            float2 b = floor(q), f = q - b;
            int2 c = int2(b);
            return mix(mix(texel(c, n), texel(c + int2(1, 0), n), f.x), mix(texel(c + int2(0, 1), n), texel(c + int2(1, 1), n), f.x), f.y);
          }
        };
        struct ExactShader {
        \(members.joined(separator: "\n"))
        \(body)
        };
        struct ExactVarying { float4 position [[position]]; };
        vertex ExactVarying exact_vertex(uint vid [[vertex_id]]) {
          ExactVarying o;
          o.position = float4(float((vid << 1) & 2) * 2.0 - 1.0, float(vid & 2) * 2.0 - 1.0, 0.0, 1.0);
          return o;
        }
        fragment float4 exact_fragment(ExactVarying in [[stage_in]], constant float *v [[buffer(0)]]\(args)) {
          ExactShader s;
        \(fill)  return s.exact_main(in.position.xy * float2(v[0], v[1]) / float2(v[2], v[3]));
        }
        """
        return (code, d)
    }

    static func placement(_ sizing: String, box: (Double, Double), image: (Double, Double)) -> [Double] {
        let fx = box.0 / image.0, fy = box.1 / image.1
        let sx = sizing == "fill" ? fx : (sizing == "contain" ? min(fx, fy) : max(fx, fy))
        let sy = sizing == "fill" ? fy : sx
        let ox = (box.0 - image.0 * sx) / 2, oy = (box.1 - image.1 * sy) / 2
        return [1 / (sx * image.0), 1 / (sy * image.1), -ox / (sx * image.0), -oy / (sy * image.1)]
    }
}
