# 光圈素材来源

用户提供的光圈模型 `base_basic_shaded.usdz`，SHA-256：
`5c2843d00426fe672b7255c392354c2df425ffb323c5ccf0ff403eb19745c63a`。

`wheel.png` 来自仓库的 `render_kill_wheel.swift`，使用 SceneKit 和 Metal 离线渲染模型，不是刷新用的程序生成圆环。原始 USDZ 保留在用户本地，应用仅使用 120×120 的透明预渲染图。Live Activity 通过 SwiftUI 旋转、位移和文字遮罩完成吞噬效果；不在灵动岛内实时运行 3D 引擎。

在 Mac 执行 `swift render_kill_wheel.swift model.usdz output-directory`，复制生成的 `wheel-0.png` 到本目录并命名为 `wheel.png`。
