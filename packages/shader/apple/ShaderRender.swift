import CoreGraphics
import Foundation
import ImageIO
import Metal

struct ShaderImage {
    var texture: MTLTexture
    var sizing = "cover"
    var tile = "decal"
}

enum ShaderRender {
    static func texture(_ device: MTLDevice, rgba: [UInt8], width: Int, height: Int) throws -> MTLTexture {
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: width, height: height, mipmapped: false)
        d.usage = .shaderRead
        guard let t = device.makeTexture(descriptor: d) else { throw ShaderRefusal("an image of \(width) by \(height) could not be made a texture") }
        t.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: rgba, bytesPerRow: width * 4)
        return t
    }

    static func decode(_ data: Data) throws -> (rgba: [UInt8], width: Int, height: Int) {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw ShaderRefusal("the image could not be decoded") }
        let w = image.width, h = image.height
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let drew = bytes.withUnsafeMutableBytes { raw -> Bool in
            guard let context = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        if !drew { throw ShaderRefusal("the image could not be drawn") }
        return (bytes, w, h)
    }

    static func buffer(_ declared: ShaderSkSL.Declared, box: (Double, Double), view: (Double, Double), images: [String: ShaderImage], values: [(name: String, value: [Double])]) -> (floats: [Float], problems: [String]) {
        var out: [Float] = [box.0, box.1, view.0, view.1].map { Float($0) }
        var problems: [String] = []
        for name in declared.shaders {
            guard let image = images[name] else { out += [0, 0, 0, 0, 0]; continue }
            let m = ShaderSkSL.placement(image.sizing, box: box, image: (Double(image.texture.width), Double(image.texture.height)))
            out += m.map { Float($0) } + [image.tile == "clamp" ? 1 : 0]
        }
        var given: [String: [Double]] = [:]
        for (name, value) in values {
            guard let want = declared.floats.first(where: { $0.name == name }) else { problems.append("uniform `\(name)` is not declared by the shader"); continue }
            if value.count != want.size || value.contains(where: { !$0.isFinite }) { problems.append("uniform `\(name)` takes \(want.size) finite number\(want.size > 1 ? "s" : "")"); continue }
            given[name] = value
        }
        for f in declared.floats { out += (given[f.name] ?? [Double](repeating: 0, count: f.size)).map { Float($0) } }
        return (out, problems)
    }
}

final class ShaderPipeline {
    let declared: ShaderSkSL.Declared
    let state: MTLRenderPipelineState

    init(device: MTLDevice, source: String, format: MTLPixelFormat) throws {
        let (code, declared) = try ShaderSkSL.toMSL(source)
        self.declared = declared
        let options = MTLCompileOptions()
        if #available(iOS 18.0, macOS 15.0, *) { options.mathMode = .safe } else { options.fastMathEnabled = false }
        let library: MTLLibrary
        do { library = try device.makeLibrary(source: code, options: options) } catch { throw ShaderRefusal("the shader did not compile: \(error.localizedDescription)") }
        let d = MTLRenderPipelineDescriptor()
        d.vertexFunction = library.makeFunction(name: "exact_vertex")
        d.fragmentFunction = library.makeFunction(name: "exact_fragment")
        d.colorAttachments[0].pixelFormat = format
        state = try device.makeRenderPipelineState(descriptor: d)
    }

    func encode(_ encoder: MTLRenderCommandEncoder, box: (Double, Double), view: (Double, Double), images: [String: ShaderImage], values: [(name: String, value: [Double])]) -> [String] {
        let (floats, problems) = ShaderRender.buffer(declared, box: box, view: view, images: images, values: values)
        encoder.setRenderPipelineState(state)
        encoder.setFragmentBytes(floats, length: floats.count * MemoryLayout<Float>.stride, index: 0)
        for (unit, name) in declared.shaders.enumerated() { if let image = images[name] { encoder.setFragmentTexture(image.texture, index: unit) } }
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        return problems
    }
}
