package dev.matrix.shell;

import static org.junit.Assert.*;
import java.util.Set;
import org.junit.Test;

public class MatrixWidgetPinTest {
    @Test public void acceptedRequestAndExistingWidgetAreNotConfirmation() {
        assertEquals("requested", MatrixWidgetPin.evaluate("r", false, Set.of("7"), Set.of("7"), 100));
        assertEquals("unconfirmed", MatrixWidgetPin.evaluate("r", false, Set.of("7"), Set.of("7"), 15000));
        assertEquals("unconfirmed", MatrixWidgetPin.evaluate("r", false, Set.of("7"), Set.of(), 20000));
    }
    @Test public void newIdConfirmsEvenWhenOldWidgetWasRemoved() {
        assertEquals("confirmed", MatrixWidgetPin.evaluate("r", false, Set.of("7"), Set.of("8"), 20000));
        assertEquals("confirmed", MatrixWidgetPin.evaluate("r", false, Set.of(), Set.of("8"), 100));
    }
    @Test public void delayedCallbackStillConfirmsButStaleCallbackCannotConfirmNewRequest() {
        assertEquals("confirmed", MatrixWidgetPin.evaluate("r", true, Set.of(), Set.of(), 60000));
        assertTrue(MatrixWidgetPin.acceptsCallback("new", "new"));
        assertFalse(MatrixWidgetPin.acceptsCallback("new", "old"));
        assertFalse(MatrixWidgetPin.acceptsCallback("", ""));
        assertFalse(MatrixWidgetPin.acceptsCallback("new", null));
    }
    @Test public void manualWidgetsWithoutARequestRemainIdleAndClockChangeDoesNotMeanSuccess() {
        assertEquals("idle", MatrixWidgetPin.evaluate("", false, Set.of(), Set.of("8"), 0));
        assertEquals("unconfirmed", MatrixWidgetPin.evaluate("r", false, Set.of(), Set.of(), -1));
    }
}
