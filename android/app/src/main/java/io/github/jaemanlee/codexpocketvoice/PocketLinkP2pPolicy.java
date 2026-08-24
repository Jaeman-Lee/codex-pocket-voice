package io.github.jaemanlee.codexpocketvoice;

import java.text.Normalizer;

final class PocketLinkP2pPolicy {
    static final int MAX_CANDIDATES = 16;
    static final long DISCOVERY_WINDOW_MS = 12_000L;
    static final long REVIEW_WINDOW_MS = 120_000L;
    static final long CONNECTION_TIMEOUT_MS = 30_000L;

    private PocketLinkP2pPolicy() {}

    static String normalizeDeviceName(String value) {
        if (value == null) return null;
        String normalized = Normalizer.normalize(value, Normalizer.Form.NFC).trim();
        if (normalized.isEmpty() || normalized.length() > 60) return null;
        for (int index = 0; index < normalized.length(); index += 1) {
            int type = Character.getType(normalized.charAt(index));
            if (type == Character.CONTROL || type == Character.FORMAT) return null;
        }
        return normalized;
    }

    static boolean validDeviceAddress(String value) {
        if (value == null || !value.matches("(?i)[0-9a-f]{2}(?::[0-9a-f]{2}){5}")) return false;
        String compact = value.replace(":", "").toLowerCase();
        if ("000000000000".equals(compact) || "ffffffffffff".equals(compact)) return false;
        int first = Integer.parseInt(compact.substring(0, 2), 16);
        return (first & 1) == 0;
    }

    static boolean validCandidateId(String value) {
        return value != null && value.matches("[A-Za-z0-9_-]{24}");
    }
}
