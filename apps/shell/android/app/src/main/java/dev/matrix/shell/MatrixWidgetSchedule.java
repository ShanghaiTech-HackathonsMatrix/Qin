package dev.matrix.shell;

import java.util.Calendar;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.TimeZone;

/** 仅依据已保存的具体课时计算；不猜测周期规则或平台数据。 */
public final class MatrixWidgetSchedule {
    public static final class Session {
        public final String course;
        public final String location;
        public final long startAt;
        public final long endAt;

        public Session(String course, String location, long startAt, long endAt) {
            this.course = course;
            this.location = location;
            this.startAt = startAt;
            this.endAt = endAt;
        }
    }

    public static List<Session> remaining(List<Session> sessions, long now, TimeZone zone) {
        long dayStart = dayStart(now, zone);
        long dayEnd = nextDay(now, zone);
        List<Session> result = new ArrayList<>();
        for (Session session : sessions) {
            if (session.startAt < dayStart || session.startAt >= dayEnd
                    || now >= session.endAt) continue;
            result.add(session);
        }
        result.sort(Comparator.comparingLong((Session s) -> s.startAt)
                .thenComparingLong(s -> s.endAt).thenComparing(s -> s.course));
        return result;
    }

    public static Session select(List<Session> sessions, long now, TimeZone zone) {
        List<Session> rows = remaining(sessions, now, zone);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public static long nextChange(List<Session> sessions, long now, TimeZone zone) {
        long next = nextDay(now, zone);
        for (Session session : remaining(sessions, now, zone)) next = Math.min(next, session.endAt);
        return next;
    }

    private static long dayStart(long now, TimeZone zone) {
        Calendar date = Calendar.getInstance(zone);
        date.setTimeInMillis(now);
        date.set(Calendar.HOUR_OF_DAY, 0);
        date.set(Calendar.MINUTE, 0);
        date.set(Calendar.SECOND, 0);
        date.set(Calendar.MILLISECOND, 0);
        return date.getTimeInMillis();
    }

    private static long nextDay(long now, TimeZone zone) {
        Calendar date = Calendar.getInstance(zone);
        date.setTimeInMillis(dayStart(now, zone));
        date.add(Calendar.DAY_OF_MONTH, 1);
        return date.getTimeInMillis();
    }

    private MatrixWidgetSchedule() {}
}
