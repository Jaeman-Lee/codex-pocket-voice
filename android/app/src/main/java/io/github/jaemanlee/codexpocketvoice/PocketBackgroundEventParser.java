package io.github.jaemanlee.codexpocketvoice;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;

final class PocketBackgroundEventParser {
    interface Listener {
        void onNotification(NotificationEvent event) throws IOException;
        void onCursor(long cursor, boolean reset) throws IOException;
    }

    static final class NotificationEvent {
        final long cursor;
        final String kind;
        final String operationId;
        final String occurredAt;
        final String expiresAt;

        NotificationEvent(long cursor, String kind, String operationId, String occurredAt, String expiresAt) {
            this.cursor = cursor;
            this.kind = kind;
            this.operationId = operationId;
            this.occurredAt = occurredAt;
            this.expiresAt = expiresAt;
        }
    }

    private PocketBackgroundEventParser() {}

    static void read(InputStream input, Listener listener) throws IOException {
        String eventId = null;
        StringBuilder data = new StringBuilder();
        while (true) {
            String line = readLine(input);
            if (line == null) {
                dispatch(eventId, data, listener);
                return;
            }
            if (line.isEmpty()) {
                dispatch(eventId, data, listener);
                eventId = null;
                data.setLength(0);
                continue;
            }
            if (line.startsWith(":")) continue;
            int separator = line.indexOf(':');
            String field = separator < 0 ? line : line.substring(0, separator);
            String value = separator < 0 ? "" : line.substring(separator + 1);
            if (value.startsWith(" ")) value = value.substring(1);
            if ("id".equals(field)) {
                eventId = value;
            } else if ("data".equals(field)) {
                if (data.length() > 0) data.append('\n');
                data.append(value);
                if (data.toString().getBytes(StandardCharsets.UTF_8).length
                        > PocketBackgroundEventPolicy.MAX_SSE_EVENT_BYTES) {
                    throw new IOException("Background event exceeds the safe size limit");
                }
            }
        }
    }

    private static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        while (true) {
            int value = input.read();
            if (value < 0) {
                return bytes.size() == 0 ? null : decodeLine(bytes);
            }
            if (value == '\n') return decodeLine(bytes);
            if (bytes.size() >= PocketBackgroundEventPolicy.MAX_SSE_LINE_BYTES) {
                throw new IOException("Background event line exceeds the safe size limit");
            }
            bytes.write(value);
        }
    }

    private static String decodeLine(ByteArrayOutputStream bytes) {
        byte[] value = bytes.toByteArray();
        int length = value.length > 0 && value[value.length - 1] == '\r' ? value.length - 1 : value.length;
        return new String(value, 0, length, StandardCharsets.UTF_8);
    }

    private static void dispatch(String eventId, StringBuilder data, Listener listener) throws IOException {
        if (data.length() == 0) return;
        final JSONObject event;
        try {
            event = new JSONObject(data.toString());
        } catch (JSONException error) {
            throw new IOException("Background event JSON is invalid", error);
        }
        String type = requiredString(event, "type");
        if ("work_notification".equals(type)) {
            parseNotification(eventId, event, listener);
            return;
        }
        if (!"notification_stream".equals(type)) return;
        String action = requiredString(event, "action");
        if ("connected".equals(action)) {
            requireExactKeys(event, "type", "action", "latestCursor", "replayed");
            safeCursor(event, "latestCursor");
            Object replayedValue = event.opt("replayed");
            if (!(replayedValue instanceof Number)) throw new IOException("Notification replay count is invalid");
            long replayed = ((Number) replayedValue).longValue();
            if (replayed < 0 || replayed > 16 || ((Number) replayedValue).doubleValue() != (double) replayed) {
                throw new IOException("Notification replay count is invalid");
            }
            return;
        }
        if ("reset".equals(action) || "replay_complete".equals(action)) {
            requireExactKeys(event, "type", "action", "latestCursor");
            listener.onCursor(safeCursor(event, "latestCursor"), "reset".equals(action));
        }
    }

    private static void parseNotification(String eventId, JSONObject event, Listener listener) throws IOException {
        long cursor = PocketBackgroundEventPolicy.parseCursor(eventId);
        if (cursor < 0) throw new IOException("Notification cursor is invalid");
        Object schema = event.opt("schema");
        if (!(schema instanceof Number) || ((Number) schema).longValue() != 1
                || ((Number) schema).doubleValue() != 1d) {
            throw new IOException("Notification schema is invalid");
        }
        String kind = requiredString(event, "kind");
        boolean approval = "approval".equals(kind);
        if (approval) {
            requireExactKeys(event, "schema", "type", "kind", "operationId", "occurredAt", "expiresAt");
        } else {
            requireExactKeys(event, "schema", "type", "kind", "operationId", "occurredAt");
        }
        if (!"completed".equals(kind) && !"failed".equals(kind) && !approval) {
            throw new IOException("Notification kind is invalid");
        }
        String operationId = requiredString(event, "operationId");
        String occurredAt = requiredString(event, "occurredAt");
        String expiresAt = approval ? requiredString(event, "expiresAt") : null;
        if (!PocketBackgroundEventPolicy.validIdentifier(
                operationId,
                PocketBackgroundEventPolicy.MAX_OPERATION_ID
        ) || PocketBackgroundEventPolicy.parseTimestamp(occurredAt) < 0
                || (approval && PocketBackgroundEventPolicy.parseTimestamp(expiresAt) < 0)) {
            throw new IOException("Notification fields are invalid");
        }
        listener.onNotification(new NotificationEvent(cursor, kind, operationId, occurredAt, expiresAt));
    }

    private static long safeCursor(JSONObject event, String key) throws IOException {
        Object raw = event.opt(key);
        if (!(raw instanceof Number)) throw new IOException("Notification stream cursor is invalid");
        long cursor = ((Number) raw).longValue();
        if (cursor < 0 || cursor > PocketBackgroundEventPolicy.MAX_CURSOR
                || ((Number) raw).doubleValue() != (double) cursor) {
            throw new IOException("Notification stream cursor is invalid");
        }
        return cursor;
    }

    private static String requiredString(JSONObject event, String key) throws IOException {
        Object raw = event.opt(key);
        if (!(raw instanceof String)) throw new IOException("Background event string field is invalid");
        return (String) raw;
    }

    private static void requireExactKeys(JSONObject event, String... expected) throws IOException {
        Set<String> keys = new HashSet<>();
        Iterator<String> iterator = event.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        Set<String> required = new HashSet<>();
        for (String key : expected) required.add(key);
        if (!keys.equals(required)) throw new IOException("Background event fields are invalid");
    }
}
