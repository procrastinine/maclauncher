// swift-tools-version: 6.2
import Foundation
import PackageDescription

guard let path = ProcessInfo.processInfo.environment["MACLAUNCHER_MLX_DLSS_SOURCE"],
  let data = FileManager.default.contents(atPath: path + "/maclauncher-adaptation.json"),
  let metadata = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
  metadata["upstreamCommit"] as? String == "7870371e8bf6c03967213f1a5d40db6c5a3bee38",
  let adaptations = metadata["adaptations"] as? [[String: Any]],
  adaptations.contains(where: { $0["id"] as? String == "kernel-parameters-cache-lock-v2" }) else {
  fatalError("Use native/build.sh to prepare the synchronized MLX-DLSS source before building this provider.")
}
let upstream = Package.Dependency.package(name: "MLXDLSS", path: path)

let package = Package(
  name: "MacLauncherNeural",
  platforms: [.macOS(.v14)],
  products: [.library(name: "MacLauncherNeural", type: .dynamic, targets: ["MacLauncherNeural"]),
    .executable(name: "maclauncher-neural-video", targets: ["MacLauncherNeuralVideo"])],
  dependencies: [upstream],
  targets: [
    .target(name: "CNeural", publicHeadersPath: "include"),
    .target(name: "MacLauncherNeural", dependencies: ["CNeural",
      .product(name: "DLSSCore", package: "MLXDLSS"),
      .product(name: "DLSSMLX", package: "MLXDLSS"),
      .product(name: "DLSSMedia", package: "MLXDLSS")],
      linkerSettings: [.linkedFramework("CoreVideo"), .linkedFramework("IOSurface"),
        .linkedFramework("Metal")]),
    .executableTarget(name: "MacLauncherNeuralVideo", dependencies: [
      .product(name: "DLSSMedia", package: "MLXDLSS")]),
    .testTarget(name: "MacLauncherNeuralTests", dependencies: ["CNeural", "MacLauncherNeural",
      .product(name: "DLSSMLX", package: "MLXDLSS")]),
  ]
)
