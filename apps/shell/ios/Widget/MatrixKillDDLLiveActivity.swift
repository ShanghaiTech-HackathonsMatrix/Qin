import ActivityKit
import SwiftUI
import WidgetKit

struct MatrixKillDDLLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MatrixKillDDLAttributes.self) { context in
            VStack(alignment: .leading, spacing: 6) {
                Text(context.attributes.isDemo ? "演示提交 / Demo submission" : "平台确认已提交 / Submission confirmed")
                    .font(.caption2).foregroundStyle(.mint)
                Text(context.attributes.course).font(.caption).lineLimit(1)
                KillDDLTrack(title: context.attributes.title, progress: context.state.progress, compact: false)
            }
            .padding(16)
            .activityBackgroundTint(.black)
            .activitySystemActionForegroundColor(.white)
            .foregroundStyle(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.attributes.isDemo ? "演示 / Demo" : "已提交 / Submitted")
                        .font(.caption2).foregroundStyle(.mint)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text("KILL DDL").font(.caption2.weight(.bold)).foregroundStyle(.mint)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.attributes.course).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        KillDDLTrack(title: context.attributes.title, progress: context.state.progress, compact: false)
                    }
                }
            } compactLeading: {
                Text(context.attributes.isDemo ? "演示" : "✓")
                    .font(.caption2.weight(.semibold)).foregroundStyle(.mint)
            } compactTrailing: {
                Text(context.state.progress == 1 ? "✓ DDL" : context.attributes.title)
                    .font(.caption2.weight(.semibold)).lineLimit(1)
                    .frame(width: 88, height: 28)
            } minimal: {
                Image("MatrixKillWheel").resizable().scaledToFit().frame(width: 24, height: 24)
                    .accessibilityLabel("DDL 完成效果 / DDL completed")
            }
            .keylineTint(.mint)
        }
    }
}

private struct KillDDLTrack: View {
    let title: String
    let progress: Double
    let compact: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isLuminanceReduced) private var luminanceReduced

    private var wheelSize: CGFloat { compact ? 24 : 80 }
    private var clampedProgress: Double { min(1, max(0, progress)) }
    private var animated: Bool { !reduceMotion && !luminanceReduced }

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let fraction = CGFloat(clampedProgress)
            ZStack(alignment: .leading) {
                fracturedLabel(width: width)
                ZStack {
                    // The glow and speed trails travel with the model, within
                    // the expanded island's bounds; no per-frame activity updates.
                    ForEach(0..<5) { index in
                        Capsule()
                            .fill(index.isMultiple(of: 2) ? Color.green : Color.mint)
                            .frame(width: CGFloat(38 + index * 9), height: index == 2 ? 3 : 1.5)
                            .shadow(color: .green, radius: 5)
                            .offset(x: -26 - CGFloat(index * 4), y: CGFloat(index - 2) * 9)
                    }
                    Circle().stroke(.green.opacity(0.65), lineWidth: 4)
                        .frame(width: wheelSize * 0.78, height: wheelSize * 0.78)
                        .blur(radius: 5)
                    Image("MatrixKillWheel")
                        .resizable().scaledToFit()
                        .frame(width: wheelSize, height: wheelSize)
                        .rotationEffect(.degrees(clampedProgress * 720))
                        .shadow(color: .green.opacity(0.9), radius: 7)
                        .shadow(color: .mint.opacity(0.8), radius: 2)
                }
                .frame(width: wheelSize, height: wheelSize)
                .offset(x: width * fraction - wheelSize / 2)
                .animation(animated ? .linear(duration: 1.05) : nil, value: progress)
            }
            .frame(width: width, height: geometry.size.height)
            .clipped()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(title)，\(progress == 1 ? "已完成 / Completed" : "正在播放完成效果 / Completion effect")")
        }
        .frame(height: compact ? 28 : 94)
    }

    // Every tile contains its actual slice of the title and capsule. Delays
    // follow the wheel's horizontal position: intact ahead, flying shards behind.
    // Built-in offset/rotation/opacity animations work in archived widget views.
    private func fracturedLabel(width: CGFloat) -> some View {
        let columns = 16
        let rows = 3
        let height: CGFloat = compact ? 23 : 36
        let tileWidth = width / CGFloat(columns)
        let tileHeight = height / CGFloat(rows)
        let shattered = progress > 0
        return ZStack(alignment: .topLeading) {
            ForEach(0..<(columns * rows), id: \.self) { index in
                let column = index % columns
                let row = index / columns
                let delay = Double(column) / Double(columns) * 1.05
                let direction: CGFloat = row == 1 ? (column.isMultiple(of: 2) ? -1 : 1) : (row == 0 ? -1 : 1)
                Text(title)
                    .font(compact ? .caption2.weight(.semibold) : .callout.weight(.semibold))
                    .lineLimit(1)
                    .padding(.horizontal, compact ? 3 : 12)
                    .frame(width: width, height: height, alignment: .leading)
                    .background(.white.opacity(0.14), in: Capsule())
                    .offset(x: -CGFloat(column) * tileWidth, y: -CGFloat(row) * tileHeight)
                    .frame(width: tileWidth, height: tileHeight, alignment: .topLeading)
                    .clipped()
                    .rotationEffect(.degrees(shattered ? Double((index % 7) - 3) * 24 : 0))
                    .offset(x: shattered ? CGFloat(10 + index % 5 * 5) : 0,
                            y: shattered ? direction * CGFloat(13 + index % 4 * 7) : 0)
                    .animation(animated ? .easeOut(duration: 0.22).delay(delay) : nil, value: progress)
                    // Keep fragments solid as they break, then remove quickly.
                    .opacity(shattered ? 0 : 1)
                    .animation(animated ? .linear(duration: 0.06).delay(delay + 0.16) : nil, value: progress)
                    .position(x: (CGFloat(column) + 0.5) * tileWidth,
                              y: (CGFloat(row) + 0.5) * tileHeight)
            }
        }
        .frame(width: width, height: height)
        .frame(height: compact ? 28 : 94)
    }
}
