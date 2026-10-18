import AppIntents
import SwiftUI
import WidgetKit

private let appGroup = "group.dev.matrix.shell"
private let snapshotKey = "ddl.widget.snapshot"
private let refreshKey = "ddl.widget.refreshRequestedAt"

private struct Snapshot: Decodable {
    struct Item: Decodable, Identifiable {
        let id: String
        let course: String
        let title: String
        let dueAt: Double?
    }
    struct Lesson: Decodable, Identifiable {
        let id: String
        let course: String
        let location: String
        let startAt: Double
        let endAt: Double
    }
    let publishedAt: Double
    let items: [Item]
    let schedule: [Lesson]
}

private struct Entry: TimelineEntry {
    let date: Date
    let snapshot: Snapshot?
    let demoCleared: Bool

    init(date: Date, snapshot: Snapshot?) {
        self.date = date
        self.snapshot = snapshot
        self.demoCleared = UserDefaults(suiteName: appGroup)?.bool(forKey: "ddl.kill.demoCleared") ?? false
    }
    var refreshMessage: String {
        let defaults = UserDefaults(suiteName: appGroup)
        let requested = defaults?.double(forKey: refreshKey) ?? 0
        let consumed = defaults?.double(forKey: "ddl.widget.refreshConsumedAt") ?? 0
        let feedbackUntil = defaults?.double(forKey: "ddl.widget.feedbackVisibleUntil") ?? 0
        if requested > consumed {
            let started = defaults?.double(forKey: "ddl.widget.refreshStartedAt") ?? 0
            if started >= requested {
                if date.timeIntervalSince1970 * 1000 > requested + 120_000 {
                    return "同步尚未完成，保留原信息 / Still pending"
                }
                return "正在同步 / Syncing…"
            }
            return date.timeIntervalSince1970 * 1000 < feedbackUntil
                ? "正在连接平台 / Connecting…" : ""
        }
        let finished = defaults?.double(forKey: "ddl.widget.refreshFinishedAt") ?? 0
        let showResult = finished > 0 && date.timeIntervalSince1970 * 1000 < feedbackUntil
        if showResult, let error = defaults?.string(forKey: "ddl.widget.refreshError"), !error.isEmpty {
            if defaults?.bool(forKey: "ddl.widget.refreshPartial") == true {
                return "部分刷新完成，失败平台保留旧信息 / Partially updated · \(error)"
            }
            return "刷新失败，保留上次信息 / Refresh failed · \(error)"
        }
        if showResult {
            return "刷新完成 / Updated"
        }
        return ""
    }
}

private struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: .now, snapshot: nil) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(Entry(date: .now, snapshot: readSnapshot()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let now = Date(), snapshot = readSnapshot()
        let horizon = now.addingTimeInterval(24 * 60 * 60)
        var dates: Set<Date> = [now]
        let defaults = UserDefaults(suiteName: appGroup)
        let requested = defaults?.double(forKey: refreshKey) ?? 0
        let finished = defaults?.double(forKey: "ddl.widget.refreshFinishedAt") ?? 0
        let feedbackEvent = max(requested, finished)
        // Start the readable interval when WidgetKit builds the feedback,
        // rather than spending it while the intent/app process is launching.
        if feedbackEvent > (defaults?.double(forKey: "ddl.widget.feedbackEvent") ?? 0) {
            defaults?.set(feedbackEvent, forKey: "ddl.widget.feedbackEvent")
            defaults?.set(now.addingTimeInterval(5).timeIntervalSince1970 * 1000,
                          forKey: "ddl.widget.feedbackVisibleUntil")
        }
        let feedbackUntil = defaults?.double(forKey: "ddl.widget.feedbackVisibleUntil") ?? 0
        let clearFeedback = Date(timeIntervalSince1970: feedbackUntil / 1000)
        if clearFeedback > now && clearFeedback < horizon { dates.insert(clearFeedback) }
        let pendingCheck = Date(timeIntervalSince1970: requested / 1000 + 121)
        if pendingCheck > now && pendingCheck < horizon { dates.insert(pendingCheck) }
        // Pre-schedule the lesson handover; it does not need another network sync.
        for lesson in snapshot?.schedule ?? [] {
            let boundary = Date(timeIntervalSince1970: lesson.startAt / 1000 + 30 * 60)
            if boundary > now && boundary < horizon { dates.insert(boundary) }
        }
        if let midnight = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now)) {
            dates.insert(midnight)
        }
        completion(Timeline(entries: dates.sorted().map { Entry(date: $0, snapshot: snapshot) },
                            policy: .after(horizon)))
    }
    private func readSnapshot() -> Snapshot? {
        guard let data = UserDefaults(suiteName: appGroup)?.data(forKey: snapshotKey) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }
}

private struct DDLWidgetView: View {
    let entry: Entry
    @Environment(\.widgetFamily) private var family

    private var capacity: Int {
        let slots: Int
        switch family {
        case .systemSmall: slots = 3
        case .systemMedium: slots = 4
        default: slots = 6
        }
        return max(0, slots - (entry.demoCleared ? 0 : 1) - (entry.refreshMessage.isEmpty ? 0 : 1))
    }

    var body: some View {
        ZStack {
          VStack(spacing: 0) {
            Button(intent: MatrixWidgetRefreshIntent()) {
                VStack(alignment: .leading, spacing: 6) {
                    WidgetSectionHeader(symbol: "checklist", title: "DDL / 截止")
                    if !entry.demoCleared {
                        DDLRow(course: "演示 / Demo", title: "演示作业 / Demo DDL",
                               deadline: "明天 / Tomorrow", compact: family == .systemSmall)
                        .id("matrix-demo-ddl")
                        .transition(.opacity.combined(with: .scale(scale: 0.85, anchor: .leading)))
                    }
                    if let snapshot = entry.snapshot, !snapshot.items.isEmpty {
                        ForEach(snapshot.items.prefix(capacity)) { item in
                            DDLRow(course: item.course, title: item.title,
                                   deadline: deadline(item.dueAt), compact: family == .systemSmall)
                                .accessibilityLabel("\(item.course)，\(item.title)，\(accessibleDeadline(item.dueAt))")
                        }
                    } else if entry.demoCleared {
                        Spacer(minLength: 0)
                        Text(entry.snapshot == nil ? "请先在 App 同步 / Sync in app first" : "暂无未完成 DDL / No active deadlines")
                            .font(.caption).foregroundStyle(WidgetPalette.muted)
                        Spacer(minLength: 0)
                    }
                    if !entry.refreshMessage.isEmpty {
                        Text(entry.refreshMessage)
                            .font(.caption2).foregroundStyle(.orange).lineLimit(1)
                    }
                }
                .foregroundStyle(WidgetPalette.ink)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(12)
                .contentShape(Rectangle())
                .animation(.easeOut(duration: 1.2), value: entry.demoCleared)

            }
            // Keep the interaction style verified on device. Re-test taps before
            // changing the button style or adding privacy/invalidation modifiers.
            .buttonStyle(.borderless)
            .accessibilityIdentifier("matrix.widget.refresh.ddl")
            .accessibilityHint("单击刷新 / Tap to refresh")
            // Separate sibling button: no nested intents inside the refresh hit area.
            Button(intent: MatrixKillDDLDemoIntent(restore: entry.demoCleared)) {
                HStack {
                    Text(entry.demoCleared ? "重新加入演示 / Restore demo" : "模拟提交 / Demo submit")
                        .fontWeight(.semibold).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .font(.caption2)
                .foregroundStyle(WidgetPalette.ink)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .frame(maxWidth: .infinity)
                .background(WidgetPalette.secondaryPaper.opacity(0.35))
                .overlay(alignment: .top) { Rectangle().fill(WidgetPalette.ink.opacity(0.08)).frame(height: 0.5) }
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("matrix.widget.demo.submit")
            .accessibilityHint("演示完成特效，不提交真实作业 / Preview only")
          }
        }
        .containerBackground(for: .widget) { DDLCardBackground() }

    }

    private func deadline(_ value: Double?) -> String {
        guard let value else { return "待定 / TBD" }
        let date = Date(timeIntervalSince1970: value / 1000)
        return date.formatted(.dateTime.month(.twoDigits).day(.twoDigits)) + " "
            + date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
    }

    private func accessibleDeadline(_ value: Double?) -> String {
        guard let value else { return "截止时间待定 / Due date unknown" }
        return Date(timeIntervalSince1970: value / 1000).formatted(date: .complete, time: .shortened)
    }
}

private struct DDLRow: View {
    let course: String
    let title: String
    let deadline: String
    let compact: Bool

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: compact ? 4 : 8) {
                Text(course)
                    .font(.system(size: compact ? 10 : 11, weight: .medium))
                    .foregroundStyle(WidgetPalette.muted)
                    .frame(width: geometry.size.width * (compact ? 0.22 : 0.25), alignment: .leading)
                Text(title)
                    .font(.system(size: compact ? 11 : 12, weight: .medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(deadline)
                    .font(.system(size: compact ? 9 : 11, weight: .medium, design: .default))
                    .monospacedDigit()
                    .foregroundStyle(WidgetPalette.muted)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .lineLimit(1)
            .frame(height: geometry.size.height)
        }
        .padding(.horizontal, 6)
        .frame(height: 23)
        .background(WidgetPalette.card.opacity(0.32), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(alignment: .bottom) {
            Rectangle().fill(WidgetPalette.ink.opacity(0.06)).frame(height: 0.5).padding(.horizontal, 8)
        }
    }
}

// Retain the app's warm neutral palette, rendered with native iOS materials.
// Dark mode uses warm charcoal and light ink, without colored glass tints.
private enum WidgetPalette {
    static let paper = adaptive(light: 0xF7F7F3, dark: 0x1C1C1A)
    static let card = adaptive(light: 0xFFFFFF, dark: 0x262624)
    static let secondaryPaper = adaptive(light: 0xEFEFEB, dark: 0x30302C)
    static let ink = adaptive(light: 0x111111, dark: 0xF3F3EC)
    static let muted = adaptive(light: 0x555555, dark: 0xB8B8AF)

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let rgb = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((rgb >> 16) & 255) / 255,
                           green: CGFloat((rgb >> 8) & 255) / 255,
                           blue: CGFloat(rgb & 255) / 255, alpha: 1)
        })
    }
}

private struct WidgetSectionHeader: View {
    let symbol: String
    let title: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(WidgetPalette.muted)
            Text(title).font(.system(size: 14, weight: .semibold))
            Spacer(minLength: 0)
        }
        .foregroundStyle(WidgetPalette.ink)
        .lineLimit(1)
        .padding(.bottom, 4)
    }
}

private struct DDLCardBackground: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        ZStack {
            if reduceTransparency {
                WidgetPalette.paper
            } else {
                Rectangle().fill(.thinMaterial)
                // Warm frost across the whole surface, rather than an opaque
                // paper inset. WidgetKit controls the wallpaper contribution.
                WidgetPalette.paper.opacity(colorScheme == .dark ? 0.48 : 0.52)
                LinearGradient(
                    colors: [.white.opacity(colorScheme == .dark ? 0.10 : 0.34),
                             .clear, WidgetPalette.secondaryPaper.opacity(0.15)],
                    startPoint: .topLeading, endPoint: .bottomTrailing)
            }
            ContainerRelativeShape().inset(by: 1)
                .strokeBorder(LinearGradient(
                    colors: [.white.opacity(colorScheme == .dark ? 0.32 : 0.78),
                             .white.opacity(0.08), .white.opacity(0.30)],
                    startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.75)
        }
    }
}

private struct NextLessonWidgetView: View {
    let entry: Entry

    private var nextLesson: Snapshot.Lesson? {
        guard let lessons = entry.snapshot?.schedule else { return nil }
        let now = entry.date.timeIntervalSince1970 * 1000
        let today = Calendar.current.startOfDay(for: entry.date)
        let todayLessons = lessons.filter {
            Calendar.current.isDate(Date(timeIntervalSince1970: $0.startAt / 1000), inSameDayAs: today)
        }.sorted { $0.startAt < $1.startAt }
        return todayLessons.first { $0.startAt + 30 * 60 * 1000 > now }
    }

    var body: some View {
        ZStack {
            Button(intent: MatrixWidgetRefreshIntent()) {
                VStack(alignment: .leading, spacing: 8) {
                    WidgetSectionHeader(symbol: "calendar", title: "今日课程 / Today")
                    if let lesson = nextLesson {
                        Text(lesson.course).font(.title3.weight(.bold)).lineLimit(2)
                        HStack(spacing: 3) {
                            Text(Date(timeIntervalSince1970: lesson.startAt / 1000), style: .time)
                            Text("–")
                            Text(Date(timeIntervalSince1970: lesson.endAt / 1000), style: .time)
                        }
                        .font(.system(.caption, design: .default, weight: .medium))
                        .foregroundStyle(WidgetPalette.muted)
                        if !lesson.location.isEmpty {
                            Label(lesson.location, systemImage: "mappin.and.ellipse")
                                .font(.caption).foregroundStyle(WidgetPalette.muted).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    } else {
                        Spacer(minLength: 0)
                        Text(entry.snapshot == nil ? "请先在 App 同步 / Sync in app first" : "今天没有后续课程 / No more classes today")
                            .font(.caption).foregroundStyle(WidgetPalette.muted)
                        Spacer(minLength: 0)
                    }
                    if !entry.refreshMessage.isEmpty {
                        Text(entry.refreshMessage)
                            .font(.caption2).foregroundStyle(.orange).lineLimit(2)
                    }
                }
                .foregroundStyle(WidgetPalette.ink)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(12)
                .contentShape(Rectangle())

            }
            // Keep the interaction style verified on device. Re-test taps before
            // changing the button style or adding privacy/invalidation modifiers.
            .buttonStyle(.borderless)
            .accessibilityIdentifier("matrix.widget.refresh.lesson")
            .accessibilityHint("单击刷新 / Tap to refresh")
        }
        .containerBackground(for: .widget) { DDLCardBackground() }

    }

}

struct MatrixDDLWidget: Widget {
    let kind = "MatrixDDLWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { DDLWidgetView(entry: $0) }
            .configurationDisplayName("学习 DDL / Study deadlines")
            .description("显示课程作业和截止时间 / Courses, assignments and due dates")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
            .contentMarginsDisabled()
    }
}

struct MatrixNextLessonWidget: Widget {
    let kind = "MatrixNextLessonWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { NextLessonWidgetView(entry: $0) }
            .configurationDisplayName("今日课程 / Today's next class")
            .description("显示今天的下一节课 / Your next class today")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
            .contentMarginsDisabled()
    }
}

@main
struct MatrixWidgetBundle: WidgetBundle {
    var body: some Widget {
        MatrixDDLWidget()
        MatrixNextLessonWidget()
        MatrixRefreshLiveActivity()
        MatrixKillDDLLiveActivity()
    }
}
