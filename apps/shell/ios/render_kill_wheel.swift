// Offline asset preparation on macOS; no 3D renderer runs inside WidgetKit.
// Usage: swift render_kill_wheel.swift model.usdz output-directory
import AppKit
import SceneKit
import Metal

let args = CommandLine.arguments
guard args.count == 3 else { fatalError("Usage: render_kill_wheel.swift model.usdz output-directory") }
let scene = try SCNScene(url: URL(fileURLWithPath: args[1]), options: nil)
let model = SCNNode()
for child in scene.rootNode.childNodes { child.removeFromParentNode(); model.addChildNode(child) }
scene.rootNode.addChildNode(model)
let bounds = model.boundingBox
let center = SCNVector3((bounds.min.x + bounds.max.x)/2, (bounds.min.y + bounds.max.y)/2, (bounds.min.z + bounds.max.z)/2)
let span = max(bounds.max.x-bounds.min.x, bounds.max.y-bounds.min.y, bounds.max.z-bounds.min.z)
print("Model bounds: \(bounds), span: \(span)")
model.pivot = SCNMatrix4MakeTranslation(center.x, center.y, center.z)
model.scale = SCNVector3(2/span, 2/span, 2/span)
let camera = SCNNode()
camera.camera = SCNCamera()
camera.camera!.usesOrthographicProjection = true
camera.camera!.orthographicScale = 1.28
camera.position = SCNVector3(0, 0, 4)
scene.rootNode.addChildNode(camera)
let light = SCNNode()
light.light = SCNLight()
light.light!.type = .omni
light.light!.intensity = 1800
light.position = SCNVector3(2, 3, 4)
scene.rootNode.addChildNode(light)
let ambient = SCNNode()
ambient.light = SCNLight()
ambient.light!.type = .ambient
ambient.light!.intensity = 550
scene.rootNode.addChildNode(ambient)
scene.background.contents = NSColor.clear
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal unavailable") }
let renderer = SCNRenderer(device: device, options: nil)
renderer.scene = scene
renderer.pointOfView = camera
try FileManager.default.createDirectory(atPath: args[2], withIntermediateDirectories: true)
// Render diagnostic views first, then a complete turn around the viewing axis.
for frame in 0..<12 {
    model.eulerAngles = SCNVector3(.pi / 2 - 0.18, 0.28, -Float(frame) * .pi / 6)
    let image = renderer.snapshot(atTime: 0, with: CGSize(width: 120, height: 120), antialiasingMode: .multisampling4X)
    guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("PNG rendering failed") }
    try png.write(to: URL(fileURLWithPath: args[2]).appendingPathComponent("wheel-\(frame).png"))
}
