package io.github.jaemanlee.codexpocketvoice;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class PocketBackgroundEventPolicyTest {
    @Test
    public void parserAcceptsOnlyMinimalVersionedNotificationsAndAdvancesCursor() throws Exception {
        String stream = "data: {\"type\":\"notification_stream\",\"action\":\"connected\",\"latestCursor\":40,\"replayed\":1}\n\n"
                + "id: 41\n"
                + "data: {\"schema\":1,\"type\":\"work_notification\",\"kind\":\"approval\","
                + "\"operationId\":\"operation-1\",\"occurredAt\":\"2026-08-24T00:00:00.000Z\","
                + "\"expiresAt\":\"2026-08-24T00:10:00.000Z\"}\n\n"
                + "data: {\"type\":\"notification_stream\",\"action\":\"replay_complete\",\"latestCursor\":42}\n\n";
        List<PocketBackgroundEventParser.NotificationEvent> notifications = new ArrayList<>();
        List<String> cursors = new ArrayList<>();
        PocketBackgroundEventParser.read(input(stream), new PocketBackgroundEventParser.Listener() {
            @Override
            public void onNotification(PocketBackgroundEventParser.NotificationEvent event) {
                notifications.add(event);
            }

            @Override
            public void onCursor(long cursor, boolean reset) {
                cursors.add(cursor + ":" + reset);
            }
        });

        assertEquals(1, notifications.size());
        assertEquals(41, notifications.get(0).cursor);
        assertEquals("approval", notifications.get(0).kind);
        assertEquals("operation-1", notifications.get(0).operationId);
        assertEquals("2026-08-24T00:10:00.000Z", notifications.get(0).expiresAt);
        assertEquals(List.of("42:false"), cursors);
    }

    @Test
    public void parserReportsJournalResetAndRejectsPrivateOrOversizedFields() throws Exception {
        List<String> cursors = new ArrayList<>();
        PocketBackgroundEventParser.read(input(
                "data: {\"type\":\"notification_stream\",\"action\":\"reset\",\"latestCursor\":3}\n\n"
        ), listener(new ArrayList<>(), cursors));
        assertEquals(List.of("3:true"), cursors);

        String privateField = "id: 4\n"
                + "data: {\"schema\":1,\"type\":\"work_notification\",\"kind\":\"completed\","
                + "\"operationId\":\"operation-1\",\"occurredAt\":\"2026-08-24T00:00:00.000Z\","
                + "\"workspace\":\"/private/project\"}\n\n";
        assertThrows(IOException.class, () -> PocketBackgroundEventParser.read(
                input(privateField),
                listener(new ArrayList<>(), new ArrayList<>())
        ));

        StringBuilder oversized = new StringBuilder("data: ");
        while (oversized.length() <= PocketBackgroundEventPolicy.MAX_SSE_LINE_BYTES + 10) oversized.append('x');
        oversized.append("\n\n");
        assertThrows(IOException.class, () -> PocketBackgroundEventParser.read(
                input(oversized.toString()),
                listener(new ArrayList<>(), new ArrayList<>())
        ));
    }

    @Test
    public void freshnessPolicySuppressesStaleFutureAndExpiredReplay() {
        long now = Instant.parse("2026-08-24T00:05:00.000Z").toEpochMilli();
        assertTrue(PocketBackgroundEventPolicy.shouldNotify(
                "completed", "2026-08-24T00:00:00.000Z", null, now
        ));
        assertTrue(PocketBackgroundEventPolicy.shouldNotify(
                "approval", "2026-08-24T00:04:00.000Z", "2026-08-24T00:10:00.000Z", now
        ));
        assertFalse(PocketBackgroundEventPolicy.shouldNotify(
                "completed", "2026-08-23T23:54:59.999Z", null, now
        ));
        assertFalse(PocketBackgroundEventPolicy.shouldNotify(
                "approval", "2026-08-24T00:04:00.000Z", "2026-08-24T00:04:59.999Z", now
        ));
        assertFalse(PocketBackgroundEventPolicy.shouldNotify(
                "failed", "2026-08-24T00:07:00.001Z", null, now
        ));
        assertEquals(-1, PocketBackgroundEventPolicy.parseCursor("01"));
        assertEquals(-1, PocketBackgroundEventPolicy.parseCursor("9007199254740992"));
    }

    private static PocketBackgroundEventParser.Listener listener(
            List<PocketBackgroundEventParser.NotificationEvent> notifications,
            List<String> cursors
    ) {
        return new PocketBackgroundEventParser.Listener() {
            @Override
            public void onNotification(PocketBackgroundEventParser.NotificationEvent event) {
                notifications.add(event);
            }

            @Override
            public void onCursor(long cursor, boolean reset) {
                cursors.add(cursor + ":" + reset);
            }
        };
    }

    private static ByteArrayInputStream input(String value) {
        return new ByteArrayInputStream(value.getBytes(StandardCharsets.UTF_8));
    }
}
