import ActivityKit
import SwiftUI
import WidgetKit

struct MatrixRefreshLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MatrixRefreshAttributes.self) { context in
            HStack(spacing: 12) {
                RefreshHalo(phase: context.state.phase, size: 40)
                Text(context.state.message).font(.caption).lineLimit(2)
            }
            .padding()
            .activityBackgroundTint(.black)
            .activitySystemActionForegroundColor(.white)
            .foregroundStyle(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    RefreshHalo(phase: context.state.phase, size: 40)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text("Matrix").font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.state.message).font(.caption).lineLimit(2)
                }
            } compactLeading: {
                RefreshHalo(phase: context.state.phase)
            } compactTrailing: {
                Text(context.state.phase == "syncing" ? "同步" : "Matrix").font(.caption2)
            } minimal: {
                RefreshHalo(phase: context.state.phase)
            }
            // WidgetKit owns border thickness and glow extent; only tint is public.
            .keylineTint(Color(red: 0.7, green: 1, blue: 1))
        }
    }
}

private struct RefreshHalo: View {
    let phase: String
    var size: CGFloat = 26
    var body: some View {
        ZStack {
            // Precomposed glow keeps every luminous pixel inside the compact
            // island's bounds; view blur/shadow can be clipped by the host.
            Image("MatrixRefreshHalo")
                .renderingMode(.original)
                .resizable()
                .scaledToFit()
            Image(systemName: phase == "failed" || phase == "signInRequired" ? "exclamationmark" : "arrow.triangle.2.circlepath")
                .font(.system(size: size * 0.32, weight: .bold))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .accessibilityLabel(phase == "syncing" ? "正在同步" : "刷新状态")
    }
}
