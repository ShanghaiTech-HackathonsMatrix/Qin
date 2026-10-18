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
                ? "已请求刷新，等待 App 同步 / Queued for app sync" : ""
        }
        let finished = defaults?.double(forKey: "ddl.widget.refreshFinishedAt") ?? 0
        let showResult = finished > 0 && date.timeIntervalSince1970 * 1000 < feedbackUntil
        if showResult, let error = defaults?.string(forKey: "ddl.widget.refreshError"), !error.isEmpty {
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
                    HStack(spacing: 7) {
                        Capsule().fill(Color(white: 0.62).gradient).frame(width: 3, height: 14)
                        Text("DDL / 截止").font(.system(.subheadline, design: .rounded, weight: .semibold))
                        Spacer(minLength: 0)
                    }
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
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                    }
                    if !entry.refreshMessage.isEmpty {
                        Text(entry.refreshMessage)
                            .font(.caption2).foregroundStyle(.orange).lineLimit(1)
                    }
                }
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(12)
                .contentShape(Rectangle())
                .animation(.easeOut(duration: 1.2), value: entry.demoCleared)
                .background(GlassSurface())

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
                .foregroundStyle(Color(white: 0.28))
                .padding(.horizontal, 12).padding(.vertical, 7)
                .frame(maxWidth: .infinity)
                .background(Color(white: 0.5).opacity(0.10))
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
                    .foregroundStyle(.secondary)
                    .frame(width: geometry.size.width * (compact ? 0.22 : 0.25), alignment: .leading)
                Text(title)
                    .font(.system(size: compact ? 11 : 12, weight: .medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(deadline)
                    .font(.system(size: compact ? 9 : 11, weight: .medium, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .lineLimit(1)
            .frame(height: geometry.size.height)
        }
        .frame(height: 21)
        .overlay(alignment: .bottom) { Rectangle().fill(.primary.opacity(0.06)).frame(height: 0.5) }
    }
}

private struct DDLCardBackground: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        ZStack {
            if reduceTransparency {
                Color(uiColor: .secondarySystemBackground)
            } else {
                Rectangle().fill(.thinMaterial)
                Rectangle().fill(colorScheme == .dark
                    ? Color(white: 0.16).opacity(0.62)
                    : Color(white: 0.94).opacity(0.56))
                LinearGradient(
                    colors: colorScheme == .dark
                        ? [.white.opacity(0.18), Color(white: 0.45).opacity(0.10), .black.opacity(0.24)]
                        : [.white.opacity(0.66), Color(white: 0.92).opacity(0.24), Color(white: 0.65).opacity(0.19)],
                    startPoint: .topLeading, endPoint: .bottomTrailing)
                RadialGradient(
                    colors: [.white.opacity(colorScheme == .dark ? 0.18 : 0.65), .clear],
                    center: .topLeading, startRadius: 0, endRadius: 190)
                // Specular rim and inner dark edge create a visible glass thickness.
                ContainerRelativeShape()
                    .inset(by: 1)
                    .strokeBorder(LinearGradient(
                        colors: [.white.opacity(0.95), .white.opacity(0.40),
                                 .white.opacity(0.06), .white.opacity(0.55)],
                        startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1.5)
                ContainerRelativeShape()
                    .inset(by: 3)
                    .strokeBorder(LinearGradient(
                        colors: [.black.opacity(colorScheme == .dark ? 0.20 : 0.09), .clear,
                                 .white.opacity(0.18)],
                        startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.75)
            }
        }
    }
}

private struct GlassSurface: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        RoundedRectangle(cornerRadius: 18, style: .continuous)
            .fill(.thinMaterial)
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(colorScheme == .dark
                        ? Color(white: 0.16).opacity(0.62)
                        : Color(white: 0.94).opacity(0.56))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(LinearGradient(
                        colors: colorScheme == .dark
                            ? [Color(white: 0.92).opacity(0.13), Color(white: 0.05).opacity(0.22)]
                            : [Color(white: 1).opacity(0.42), Color(white: 0.72).opacity(0.10)],
                        startPoint: .topLeading, endPoint: .bottomTrailing))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(.white.opacity(colorScheme == .dark ? 0.28 : 0.62), lineWidth: 1)
            }
            .shadow(color: .black.opacity(colorScheme == .dark ? 0.28 : 0.12), radius: 8, y: 3)
            .padding(4)
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
                    HStack {
                        Text("今日课程 / Today").font(.headline)
                    }
                    if let lesson = nextLesson {
                        Text(lesson.course).font(.title3.weight(.semibold)).lineLimit(2)
                        HStack(spacing: 3) {
                            Text(Date(timeIntervalSince1970: lesson.startAt / 1000), style: .time)
                            Text("–")
                            Text(Date(timeIntervalSince1970: lesson.endAt / 1000), style: .time)
                        }
                        .font(.caption).foregroundStyle(.secondary)
                        if !lesson.location.isEmpty {
                            Label(lesson.location, systemImage: "mappin.and.ellipse")
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    } else {
                        Spacer(minLength: 0)
                        Text(entry.snapshot == nil ? "请先在 App 同步 / Sync in app first" : "今天没有后续课程 / No more classes today")
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                    }
                    if !entry.refreshMessage.isEmpty {
                        Text(entry.refreshMessage)
                            .font(.caption2).foregroundStyle(.orange).lineLimit(2)
                    }
                }
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
        .containerBackground(.background, for: .widget)

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
