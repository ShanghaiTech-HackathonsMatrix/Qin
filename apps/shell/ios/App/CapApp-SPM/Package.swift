// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3"),
        .package(name: "AparajitaCapacitorSecureStorage", path: "../../../node_modules/@aparajita/capacitor-secure-storage"),
        .package(name: "CapacitorCommunitySqlite", path: "../../../node_modules/@capacitor-community/sqlite"),
        .package(name: "CapacitorPreferences", path: "../../../node_modules/@capacitor/preferences"),
        .package(name: "MatrixCapacitorNotify", path: "../../../../../packages/capacitor-notify")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "AparajitaCapacitorSecureStorage", package: "AparajitaCapacitorSecureStorage"),
                .product(name: "CapacitorCommunitySqlite", package: "CapacitorCommunitySqlite"),
                .product(name: "CapacitorPreferences", package: "CapacitorPreferences"),
                .product(name: "MatrixCapacitorNotify", package: "MatrixCapacitorNotify")
            ]
        )
    ]
)
