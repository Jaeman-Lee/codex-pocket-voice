package io.github.jaemanlee.codexpocketvoice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PocketLinkP2pPolicyTest {
    @Test
    public void candidateNamesAreNormalizedAndBounded() {
        assertEquals("작업실 PC", PocketLinkP2pPolicy.normalizeDeviceName("  작업실 PC  "));
        assertEquals("Café", PocketLinkP2pPolicy.normalizeDeviceName("Cafe\u0301"));
        assertNull(PocketLinkP2pPolicy.normalizeDeviceName(""));
        assertNull(PocketLinkP2pPolicy.normalizeDeviceName("bad\nname"));
        assertNull(PocketLinkP2pPolicy.normalizeDeviceName("x".repeat(61)));
    }

    @Test
    public void peerAddressesRejectMulticastZeroAndMalformedValues() {
        assertTrue(PocketLinkP2pPolicy.validDeviceAddress("02:11:22:33:44:55"));
        assertTrue(PocketLinkP2pPolicy.validDeviceAddress("A2:B3:C4:D5:E6:F7"));
        assertFalse(PocketLinkP2pPolicy.validDeviceAddress("01:11:22:33:44:55"));
        assertFalse(PocketLinkP2pPolicy.validDeviceAddress("00:00:00:00:00:00"));
        assertFalse(PocketLinkP2pPolicy.validDeviceAddress("ff:ff:ff:ff:ff:ff"));
        assertFalse(PocketLinkP2pPolicy.validDeviceAddress("02:11:22:33:44"));
    }

    @Test
    public void reviewTokensAreOpaqueAndExactLength() {
        assertTrue(PocketLinkP2pPolicy.validCandidateId("abcdefghijklmnopqrstuvwx"));
        assertFalse(PocketLinkP2pPolicy.validCandidateId("short"));
        assertFalse(PocketLinkP2pPolicy.validCandidateId("abcdefghijklmnopqrstuvw+"));
    }
}
