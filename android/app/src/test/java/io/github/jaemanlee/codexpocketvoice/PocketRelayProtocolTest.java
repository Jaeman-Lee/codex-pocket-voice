package io.github.jaemanlee.codexpocketvoice;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

import org.junit.Test;

public class PocketRelayProtocolTest {
    private static final String SLOT = "abcdefghijklmnopqrstuv";
    private static final String SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

    @Test
    public void clientAttachWritesExactBoundedFrameAndLeavesNestedTlsBytesUnread() throws Exception {
        byte[] inputBytes = concat(
                "{\"version\":1,\"status\":\"paired\"}\n".getBytes(StandardCharsets.UTF_8),
                new byte[] { 0x16, 0x03, 0x03 }
        );
        ByteArrayInputStream input = new ByteArrayInputStream(inputBytes);
        ByteArrayOutputStream output = new ByteArrayOutputStream();

        PocketRelayProtocol.attach(input, output, SLOT, SECRET);

        assertEquals(
                "{\"version\":1,\"role\":\"client\",\"slot\":\"" + SLOT
                        + "\",\"secret\":\"" + SECRET + "\"}\n",
                output.toString(StandardCharsets.UTF_8.name())
        );
        assertEquals(0x16, input.read());
        assertEquals(0x03, input.read());
    }

    @Test
    public void rejectedAndUnavailableDoNotRevealCredentialState() {
        PocketRelayProtocol.RelayUnavailableException unavailable = assertThrows(
                PocketRelayProtocol.RelayUnavailableException.class,
                () -> attach("{\"version\":1,\"status\":\"unavailable\"}\n")
        );
        PocketRelayProtocol.RelayUnavailableException rejected = assertThrows(
                PocketRelayProtocol.RelayUnavailableException.class,
                () -> attach("{\"version\":1,\"status\":\"rejected\"}\n")
        );
        assertEquals(unavailable.getMessage(), rejected.getMessage());
    }

    @Test
    public void exactObjectAllowsJsonFormattingButRejectsUnknownDuplicateAndOversizedFrames() throws Exception {
        attach(" { \"status\" : \"paired\", \"version\" : 1 } \n");
        assertThrows(PocketRelayProtocol.ProtocolException.class, () -> attach(
                "{\"version\":1,\"status\":\"waiting\"}\n"
        ));
        assertThrows(PocketRelayProtocol.ProtocolException.class, () -> attach(
                "{\"version\":1,\"status\":\"paired\",\"extra\":true}\n"
        ));
        assertThrows(PocketRelayProtocol.ProtocolException.class, () -> attach(
                "{\"version\":1,\"version\":1,\"status\":\"paired\"}\n"
        ));
        assertThrows(PocketRelayProtocol.ProtocolException.class, () -> attach(
                repeat('x', PocketRelayProtocol.MAX_FRAME_BYTES + 1) + "\n"
        ));
    }

    @Test
    public void credentialsAndConnectionHostsAreStrictlyBounded() {
        assertThrows(IllegalArgumentException.class, () -> PocketRelayProtocol.validateSlot("short"));
        assertThrows(IllegalArgumentException.class, () -> PocketRelayProtocol.validateSecret("short"));
        assertTrue(PocketRelayProtocol.isConnectionHost("relay.example.test"));
        assertTrue(PocketRelayProtocol.isConnectionHost("192.0.2.8"));
        assertTrue(PocketRelayProtocol.isConnectionHost("2001:db8::8"));
        assertEquals(false, PocketRelayProtocol.isConnectionHost("localhost"));
        assertEquals(false, PocketRelayProtocol.isConnectionHost("0.0.0.0"));
        assertEquals(false, PocketRelayProtocol.isConnectionHost("bad..host"));
        assertEquals(false, PocketRelayProtocol.isConnectionHost("999.2.3.4"));
    }

    private static void attach(String response) throws Exception {
        PocketRelayProtocol.attach(
                new ByteArrayInputStream(response.getBytes(StandardCharsets.UTF_8)),
                new ByteArrayOutputStream(),
                SLOT,
                SECRET
        );
    }

    private static byte[] concat(byte[] left, byte[] right) {
        byte[] result = new byte[left.length + right.length];
        System.arraycopy(left, 0, result, 0, left.length);
        System.arraycopy(right, 0, result, left.length, right.length);
        return result;
    }

    private static String repeat(char value, int count) {
        char[] result = new char[count];
        java.util.Arrays.fill(result, value);
        return new String(result);
    }
}
