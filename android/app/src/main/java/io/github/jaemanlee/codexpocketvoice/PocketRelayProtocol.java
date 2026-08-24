package io.github.jaemanlee.codexpocketvoice;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;

import org.json.JSONObject;

final class PocketRelayProtocol {
    static final int VERSION = 1;
    static final int MAX_FRAME_BYTES = 2_048;
    static final int CONNECT_TIMEOUT_MS = 10_000;
    static final int RESPONSE_TIMEOUT_MS = 10_000;

    private static final byte[] PAIRED = "paired".getBytes(StandardCharsets.UTF_8);
    private static final byte[] UNAVAILABLE = "unavailable".getBytes(StandardCharsets.UTF_8);
    private static final byte[] REJECTED = "rejected".getBytes(StandardCharsets.UTF_8);

    private PocketRelayProtocol() {}

    static void attach(InputStream input, OutputStream output, String slot, String secret) throws IOException {
        validateSlot(slot);
        validateSecret(secret);
        byte[] request = ("{\"version\":1,\"role\":\"client\",\"slot\":\""
                + slot + "\",\"secret\":\"" + secret + "\"}\n").getBytes(StandardCharsets.UTF_8);
        if (request.length > MAX_FRAME_BYTES) throw new ProtocolException();
        output.write(request);
        output.flush();

        byte[] status = parseStatus(readFrame(input));
        if (constantTimeEquals(status, PAIRED)) return;
        if (constantTimeEquals(status, UNAVAILABLE) || constantTimeEquals(status, REJECTED)) {
            throw new RelayUnavailableException();
        }
        throw new ProtocolException();
    }

    static void validateSlot(String value) {
        if (value == null || !value.matches("[A-Za-z0-9_-]{22,86}")) {
            throw new IllegalArgumentException("invalid relay slot");
        }
    }

    static void validateSecret(String value) {
        if (value == null || !value.matches("[A-Za-z0-9_-]{43,128}")) {
            throw new IllegalArgumentException("invalid relay secret");
        }
    }

    static boolean isConnectionHost(String value) {
        if (value == null || value.isEmpty() || value.length() > 253
                || "0.0.0.0".equals(value) || "::".equals(value)
                || "localhost".equalsIgnoreCase(value)) return false;
        if (value.indexOf(':') >= 0) {
            if (!value.matches("[0-9A-Fa-f:]+")) return false;
            try {
                return InetAddress.getByName(value) instanceof Inet6Address;
            } catch (Exception ignored) {
                return false;
            }
        }
        if (value.matches("[0-9.]+")) {
            String[] parts = value.split("\\.", -1);
            if (parts.length != 4) return false;
            for (String part : parts) {
                if (part.isEmpty() || part.length() > 3 || !part.matches("[0-9]+")) return false;
                int number = Integer.parseInt(part);
                if (number < 0 || number > 255) return false;
            }
            return true;
        }
        String[] labels = value.split("\\.", -1);
        for (String label : labels) {
            if (!label.matches("[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")) return false;
        }
        return true;
    }

    private static byte[] readFrame(InputStream input) throws IOException {
        ByteArrayOutputStream frame = new ByteArrayOutputStream(64);
        while (frame.size() <= MAX_FRAME_BYTES) {
            int next = input.read();
            if (next < 0) throw new EOFException("relay response ended before a frame");
            if (next == '\n') return frame.toByteArray();
            frame.write(next);
        }
        throw new ProtocolException();
    }

    private static byte[] parseStatus(byte[] frame) throws ProtocolException {
        String encoded = new String(frame, StandardCharsets.UTF_8);
        try {
            JSONObject value = new JSONObject(encoded);
            Object version = value.get("version");
            Object status = value.get("status");
            if (value.length() != 2
                    || !(version instanceof Number)
                    || ((Number) version).doubleValue() != VERSION
                    || !(status instanceof String)
                    || occurrences(encoded, "\"version\"") != 1
                    || occurrences(encoded, "\"status\"") != 1) {
                throw new ProtocolException();
            }
            return ((String) status).getBytes(StandardCharsets.UTF_8);
        } catch (ProtocolException error) {
            throw error;
        } catch (Exception error) {
            throw new ProtocolException();
        }
    }

    private static int occurrences(String value, String needle) {
        int count = 0;
        int offset = 0;
        while ((offset = value.indexOf(needle, offset)) >= 0) {
            count += 1;
            offset += needle.length();
        }
        return count;
    }

    private static boolean constantTimeEquals(byte[] left, byte[] right) {
        int different = left.length ^ right.length;
        int length = Math.max(left.length, right.length);
        for (int index = 0; index < length; index += 1) {
            int leftByte = index < left.length ? left[index] : 0;
            int rightByte = index < right.length ? right[index] : 0;
            different |= leftByte ^ rightByte;
        }
        return different == 0;
    }

    static final class RelayUnavailableException extends IOException {
        RelayUnavailableException() {
            super("Pocket relay is unavailable");
        }
    }

    static final class ProtocolException extends IOException {
        ProtocolException() {
            super("Pocket relay response is invalid");
        }
    }
}
