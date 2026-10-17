// swift-tools-version: 5.9
import PackageDescription

// 预留骨架。激活前不会被任何构建碰到。
//
// 与 @capacitor/preferences 的 Package.swift 同构：依赖官方
// capacitor-swift-pm，产物是一个可以被 Xcode 直接加进来的 library。
//
// 这样 iOS 的同伴可以**单独**打开这个目录（Xcode → Open Package）
// 编译、跑单测，完全不需要先跑通整个 App。
let package = Package(
    name: "MatrixNotify",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "MatrixNotify", targets: ["MatrixNotify"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "MatrixNotify",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm")
            ],
            path: "Sources/MatrixNotify"
        )
    ]
)
