package dev.matrix.shell;

import static org.junit.Assert.*;

import java.util.Arrays;
import java.util.Collections;
import java.util.GregorianCalendar;
import java.util.TimeZone;
import org.junit.Test;

public class MatrixWidgetScheduleTest {
    private final TimeZone zone = TimeZone.getTimeZone("Asia/Shanghai");

    private long at(int day, int hour, int minute) {
        GregorianCalendar date = new GregorianCalendar(zone);
        date.clear();
        date.set(2026, 9, day, hour, minute);
        return date.getTimeInMillis();
    }

    private MatrixWidgetSchedule.Session course(String name, int day, int hour) {
        return new MatrixWidgetSchedule.Session(name, "教室 A", at(day, hour, 0), at(day, hour, 45));
    }

    @Test public void retainsCourseUntilItsActualEnd() {
        MatrixWidgetSchedule.Session morning = course("数学", 17, 9);
        MatrixWidgetSchedule.Session afternoon = course("物理", 17, 14);
        assertSame(morning, MatrixWidgetSchedule.select(Arrays.asList(afternoon, morning), at(17, 8, 0), zone));
        assertSame(morning, MatrixWidgetSchedule.select(Arrays.asList(afternoon, morning), at(17, 9, 29), zone));
        assertSame(morning, MatrixWidgetSchedule.select(Arrays.asList(afternoon, morning), at(17, 9, 30), zone));
        assertSame(afternoon, MatrixWidgetSchedule.select(Arrays.asList(afternoon, morning), at(17, 9, 45), zone));
        assertSame(afternoon, MatrixWidgetSchedule.select(Arrays.asList(afternoon, morning), at(17, 14, 44), zone));
        assertNull(MatrixWidgetSchedule.select(Arrays.asList(afternoon, morning), at(17, 14, 45), zone));
    }

    @Test public void neverUsesYesterdayOrTomorrow() {
        assertNull(MatrixWidgetSchedule.select(Arrays.asList(course("昨天", 16, 23), course("明天", 18, 8)),
                at(17, 10, 0), zone));
        assertNull(MatrixWidgetSchedule.select(Collections.emptyList(), at(17, 12, 0), zone));
        assertNull(MatrixWidgetSchedule.select(Collections.singletonList(course("跨午夜", 17, 23)),
                at(18, 0, 0), zone));
    }

    @Test public void schedulesCutoffAndMidnightUsingCalendarDay() {
        assertEquals(at(17, 9, 45), MatrixWidgetSchedule.nextChange(
                Collections.singletonList(course("数学", 17, 9)), at(17, 8, 0), zone));
        assertEquals(at(18, 0, 0), MatrixWidgetSchedule.nextChange(
                Collections.singletonList(course("数学", 17, 9)), at(17, 10, 0), zone));
        assertEquals(at(18, 0, 0), MatrixWidgetSchedule.nextChange(Collections.emptyList(), at(17, 10, 0), zone));
    }

    @Test public void listsAllRemainingTodayInTimeOrderAndUsesEarliestEnd() {
        MatrixWidgetSchedule.Session longClass = new MatrixWidgetSchedule.Session("实验", "", at(17, 8, 0), at(17, 12, 0));
        MatrixWidgetSchedule.Session shortClass = course("数学", 17, 9);
        MatrixWidgetSchedule.Session lateClass = course("物理", 17, 14);
        java.util.List<MatrixWidgetSchedule.Session> input = Arrays.asList(lateClass, shortClass, longClass, course("次日", 18, 8));
        assertEquals(Arrays.asList(longClass, shortClass, lateClass), MatrixWidgetSchedule.remaining(input, at(17, 9, 30), zone));
        assertEquals(at(17, 9, 45), MatrixWidgetSchedule.nextChange(input, at(17, 9, 30), zone));
        assertEquals(Arrays.asList(longClass, lateClass), MatrixWidgetSchedule.remaining(input, at(17, 9, 45), zone));
        assertTrue(MatrixWidgetSchedule.remaining(input, at(17, 15, 0), zone).isEmpty());
    }

    @Test public void usesPhoneLocalTimezoneIncludingDst() {
        TimeZone newYork = TimeZone.getTimeZone("America/New_York");
        // 中国时间 17 日凌晨，在纽约仍是 16 日，因此中国 17 日上午的课属于纽约当天。
        MatrixWidgetSchedule.Session session = course("时区测试", 17, 8);
        assertSame(session, MatrixWidgetSchedule.select(Collections.singletonList(session), at(17, 1, 0), newYork));
        GregorianCalendar dst = new GregorianCalendar(newYork);
        dst.clear();
        dst.set(2026, 2, 8, 0, 0);
        long start = dst.getTimeInMillis();
        assertEquals(23 * 60 * 60_000L, MatrixWidgetSchedule.nextChange(Collections.emptyList(), start, newYork) - start);
    }
}
