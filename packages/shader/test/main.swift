import Foundation
import Metal

func fail(_ message: String) -> Never { FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1) }
guard CommandLine.arguments.count > 1, let spec = try? JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as? [String: Any] else { fail("usage: render <spec.json>") }
let source = spec["source"] as! String
if spec["msl"] as? Bool == true {
    do { print(String(data: try JSONSerialization.data(withJSONObject: ["msl": try ShaderSkSL.toMSL(source).code]), encoding: .utf8)!) } catch { fail("\(error)") }
    exit(0)
}
guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { fail("no Metal device") }
let w = spec["width"] as! Int, h = spec["height"] as! Int
let box = (spec["box"] as! [Double])[0], boxH = (spec["box"] as! [Double])[1]
do {
    let pipeline = try ShaderPipeline(device: device, source: source, format: .bgra8Unorm)
    var images: [String: ShaderImage] = [:]
    for i in spec["images"] as! [[String: Any]] {
        let decoded = try ShaderRender.decode(Data(contentsOf: URL(fileURLWithPath: i["file"] as! String)))
        images[i["name"] as! String] = ShaderImage(texture: try ShaderRender.texture(device, rgba: decoded.rgba, width: decoded.width, height: decoded.height), sizing: i["sizing"] as? String ?? "cover", tile: i["tile"] as? String ?? "decal")
    }
    let values = (spec["uniforms"] as! [[String: Any]]).map { (name: $0["name"] as! String, value: ($0["value"] as! [Any]).map { ($0 as! NSNumber).doubleValue }) }
    let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: w, height: h, mipmapped: false)
    d.usage = [.renderTarget]; d.storageMode = .shared
    let target = device.makeTexture(descriptor: d)!
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = target
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0)
    pass.colorAttachments[0].storeAction = .store
    let commands = queue.makeCommandBuffer()!
    let encoder = commands.makeRenderCommandEncoder(descriptor: pass)!
    let problems = pipeline.encode(encoder, box: (box, boxH), view: (Double(w), Double(h)), images: images, values: values)
    encoder.endEncoding()
    commands.commit()
    commands.waitUntilCompleted()
    if let error = commands.error { fail("\(error)") }
    var bgra = [UInt8](repeating: 0, count: w * h * 4)
    target.getBytes(&bgra, bytesPerRow: w * 4, from: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0)
    var rgba = bgra
    for i in stride(from: 0, to: rgba.count, by: 4) { rgba[i] = bgra[i + 2]; rgba[i + 2] = bgra[i] }
    print(String(data: try JSONSerialization.data(withJSONObject: ["rgba": Data(rgba).base64EncodedString(), "problems": problems]), encoding: .utf8)!)
} catch { fail("\(error)") }
