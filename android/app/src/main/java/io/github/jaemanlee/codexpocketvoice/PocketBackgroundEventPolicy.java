package io.github.jaemanlee.codexpocketvoice;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

final class PocketBackgroundEventPolicy {
    static final int MAX_SUBSCRIPTIONS = 8;
    static final int MAX_DEVICE_ID = 120;
    static final int MAX_OPERATION_ID = 200;
    static final int MAX_SSE_LINE_BYTES = 8 * 1024;
    static final int MAX_SSE_EVENT_BYTES = 16 * 1024;
    static final long MAX_CURSOR = 9_007_199_254_740_991L;
    static final long MAX_REPLAY_AGE_MS = 10 * 60_000L;
    static final long MAX_FUTURE_SKEW_MS = 2 * 60_000L;

    private PocketBackgroundEventPolicy() {}

    static boolean validIdentifier(String value, int maximum) {
        if (value == null || value.isEmpty() || value.length() > maximum) return false;
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (character <= 0x1f || character == 0x7f) return false;
        }
        return true;
    }

    static boolean validToken(String value) {
        return value != null && value.matches("[A-Za-z0-9_-]{43}");
    }

    static boolean validPort(int port) {
        return port >= 1_024 && port <= 65_535;
    }

    static long parseCursor(String value) {
        if (value == null || !value.matches("(?:0|[1-9][0-9]{0,15})")) return -1;
        try {
            long cursor = Long.parseLong(value);
            return cursor <= MAX_CURSOR ? cursor : -1;
        } catch (NumberFormatException ignored) {
            return -1;
        }
    }

    static long parseTimestamp(String value) {
        if (value == null || !value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z")) {
            return -1;
        }
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setLenient(false);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        try {
            Date parsed = format.parse(value);
            return parsed == null ? -1 : parsed.getTime();
        } catch (ParseException ignored) {
            return -1;
        }
    }

    static boolean shouldNotify(String kind, String occurredAt, String expiresAt, long now) {
        if (!"completed".equals(kind) && !"failed".equals(kind) && !"approval".equals(kind)) return false;
        long occurred = parseTimestamp(occurredAt);
        if (occurred < 0 || occurred < now - MAX_REPLAY_AGE_MS || occurred > now + MAX_FUTURE_SKEW_MS) return false;
        if (!"approval".equals(kind)) return expiresAt == null;
        long expires = parseTimestamp(expiresAt);
        return expires >= now && expires <= now + 24 * 60 * 60_000L;
    }
}
