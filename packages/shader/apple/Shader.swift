// @exact/shader on Apple: `exact-shader`, a per-pixel shader (`source`, SkSL as ShaderSkSL.swift describes) over
// `images` in a Metal view that fills its box. `uniforms` set the shader's numeric uniforms by name, so state, a
// timer or a spring in Contract drives them; each change draws once, and nothing draws between changes. See ../README.md.
// - A shader coordinate is a point of the box, y down, whatever the screen's scale.
// - An image path is read through the host's asset reader (`context.asset`: the running generation's file, else the
//   bundle's), else from EXACT_ASSETS or the bundle under the agent; an `app:/` path from the session's files.
// - `load` runs after the first draw; `failed` runs with the reason, once for each reason.
import ExactPackage
import Foundation
import Metal
import MetalKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

public final class ShaderModule: NSObject, ExactPackage {
    let context: ExactPackageContext

    public init(context: ExactPackageContext) {
        self.context = context
        super.init()
    }

    public func later(_ name: String, _ args: [String: Any], preferred: Any?, reply: @escaping ([String: Any]) -> Void) {
        reply(["error": "NotSupportedError"])
    }

    public func view(_ tag: String, id: String, props: [String: String], events: ExactPackageEvents) throws -> ExactPackageView {
        guard tag == "exact-shader" else { throw ExactPackageRefusal("no view \(tag)") }
        let view = ShaderView(context: context, events: events)
        try view.setProps(props)
        return view
    }

    public func destroy(_ done: @escaping () -> Void) { done() }
}

private func objects(_ text: String?) -> [[String: Any]] {
    guard let text, let data = text.data(using: .utf8), let any = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
    return any.compactMap { $0 as? [String: Any] }
}

final class ShaderView: NSObject, ExactPackageView, MTKViewDelegate {
    private let context: ExactPackageContext
    private let events: ExactPackageEvents
    private let mtk: MTKView
    private let queue: MTLCommandQueue?
    private var pipeline: ShaderPipeline?
    private var props: [String: String] = [:]
    private var images: [String: ShaderImage] = [:]
    private var values: [(name: String, value: [Double])] = []
    private var told = false
    private var failures = Set<String>()
    private var ticket = 0

    init(context: ExactPackageContext, events: ExactPackageEvents) {
        self.context = context
        self.events = events
        let device = MTLCreateSystemDefaultDevice()
        mtk = MTKView(frame: .zero, device: device)
        queue = device?.makeCommandQueue()
        super.init()
        mtk.colorPixelFormat = .bgra8Unorm
        mtk.clearColor = MTLClearColorMake(0, 0, 0, 0)
        mtk.framebufferOnly = true
        mtk.isPaused = true
        mtk.enableSetNeedsDisplay = true
        mtk.delegate = self
        #if os(macOS)
        mtk.layer?.isOpaque = false
        #else
        mtk.isOpaque = false
        #endif
        events.intrinsicSize(nil)
    }

    var view: ExactPackagePlatformView { mtk }

    private func fail(_ reason: String) {
        if failures.insert(reason).inserted { events.emit("failed", [reason]) }
    }

    func setProps(_ next: [String: String]) throws {
        let first = props.isEmpty
        let changed = { (k: String) in first || next[k] != self.props[k] }
        props = next
        if changed("source") { rebuild(next["source"] ?? "") }
        if changed("source") || changed("images") { loadImages() }
        if changed("uniforms") {
            values = objects(next["uniforms"]).compactMap { u in
                guard let name = u["name"] as? String, let v = u["value"] as? [Any] else { return nil }
                return (name, v.map { ($0 as? NSNumber)?.doubleValue ?? .nan })
            }
        }
        redraw()
    }

    func destroy() {
        ticket += 1
        mtk.delegate = nil
    }

    private func rebuild(_ source: String) {
        pipeline = nil; images = [:]; told = false
        guard let device = mtk.device else { fail("Metal is not available"); return }
        do { pipeline = try ShaderPipeline(device: device, source: source, format: mtk.colorPixelFormat) } catch { fail("\(error)") }
    }

    private func resolve(_ path: String) -> Data? {
        if !path.hasPrefix("app:/"), let bytes = context.asset(path) { return bytes }
        var roots: [URL] = []
        if path.hasPrefix("app:/") {
            if let url = context.file(path) { roots = [url] }
        } else {
            if let assets = ProcessInfo.processInfo.environment["EXACT_ASSETS"] { roots.append(URL(fileURLWithPath: assets).appendingPathComponent(path)) }
            if let resources = Bundle.main.resourcePath { roots.append(URL(fileURLWithPath: resources).appendingPathComponent(path)) }
        }
        return roots.first(where: { FileManager.default.fileExists(atPath: $0.path) }).flatMap { try? Data(contentsOf: $0) }
    }

    private func loadImages() {
        guard let pipeline, let device = mtk.device else { return }
        ticket += 1
        let mine = ticket
        let wanted = objects(props["images"])
        for name in pipeline.declared.shaders where !wanted.contains(where: { $0["name"] as? String == name }) {
            fail("the shader reads image `\(name)`, which `images` does not list")
        }
        for spec in wanted {
            guard let name = spec["name"] as? String, let path = spec["source"] as? String, pipeline.declared.shaders.contains(name) else { continue }
            let sizing = (spec["sizing"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "cover"
            let tile = spec["tile"] as? String ?? "decal"
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let result = Result<(rgba: [UInt8], width: Int, height: Int), Error> {
                    guard let data = self?.resolve(path) else { throw ShaderRefusal("\(path): no such file") }
                    return try ShaderRender.decode(data)
                }
                DispatchQueue.main.async {
                    guard let self, mine == self.ticket else { return }
                    switch result {
                    case .failure(let error): self.fail("\(path): \(error)")
                    case .success(let image):
                        do {
                            self.images[name] = ShaderImage(texture: try ShaderRender.texture(device, rgba: image.rgba, width: image.width, height: image.height), sizing: sizing, tile: tile)
                            self.redraw()
                        } catch { self.fail("\(error)") }
                    }
                }
            }
        }
    }

    private func redraw() {
        #if os(macOS)
        mtk.needsDisplay = true
        #else
        mtk.setNeedsDisplay()
        #endif
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        guard let pipeline, let queue, view.drawableSize.width > 0, view.bounds.width > 0,
              pipeline.declared.shaders.allSatisfy({ images[$0] != nil }),
              let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
              let commands = queue.makeCommandBuffer(), let encoder = commands.makeRenderCommandEncoder(descriptor: pass) else { return }
        let problems = pipeline.encode(encoder, box: (Double(view.bounds.width), Double(view.bounds.height)), view: (Double(view.drawableSize.width), Double(view.drawableSize.height)), images: images, values: values)
        encoder.endEncoding()
        commands.present(drawable)
        commands.commit()
        problems.forEach(fail)
        if !told { told = true; events.load() }
    }
}
