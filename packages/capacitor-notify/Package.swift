// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MatrixCapacitorNotify",
    platforms: [.iOS(.v15)],
    products: [.library(name: "MatrixCapacitorNotify", targets: ["MatrixNotify"])],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(name: "MatrixNotify", dependencies: [
            .product(name: "Capacitor", package: "capacitor-swift-pm")
        ], path: "ios/Sources/MatrixNotify"),
        .testTarget(name: "MatrixNotifyTests", dependencies: ["MatrixNotify"], path: "ios/Tests/MatrixNotifyTests")
    ]
)
