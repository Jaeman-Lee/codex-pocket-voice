package io.github.jaemanlee.codexpocketvoice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class PocketLinkDiscoveryPolicyTest {
    @Test
    public void exactProtocolSelectsAResolvedPrivateLanAddress() throws Exception {
        PocketLinkDiscoveryPolicy.Candidate candidate = PocketLinkDiscoveryPolicy.candidate(
                "작업실 Linux",
                "_codexpocket._tcp",
                8789,
                versionAttributes(),
                Arrays.asList(
                        InetAddress.getByName("203.0.113.8"),
                        InetAddress.getByName("fd00::8"),
                        InetAddress.getByName("192.168.10.8")
                )
        );

        assertEquals("작업실 Linux", candidate.name);
        assertEquals("192.168.10.8", candidate.host);
        assertEquals(8789, candidate.port);
    }

    @Test
    public void discoveryRejectsPublicLoopbackAndWildcardAddresses() throws Exception {
        for (String host : Arrays.asList("203.0.113.8", "127.0.0.1", "0.0.0.0", "::1")) {
            assertThrows(SecurityException.class, () -> PocketLinkDiscoveryPolicy.candidate(
                    "Linux PC", PocketLinkDiscoveryPolicy.SERVICE_TYPE, 8789, versionAttributes(),
                    Collections.singletonList(InetAddress.getByName(host))
            ));
        }
    }

    @Test
    public void discoveryRejectsTxtSmugglingWrongTypeAndUnsupportedVersion() throws Exception {
        Map<String, byte[]> smuggled = versionAttributes();
        smuggled.put("pin", "sha256/untrusted".getBytes(StandardCharsets.US_ASCII));
        assertThrows(SecurityException.class, () -> PocketLinkDiscoveryPolicy.candidate(
                "Linux PC", PocketLinkDiscoveryPolicy.SERVICE_TYPE, 8789, smuggled,
                Collections.singletonList(InetAddress.getByName("10.0.0.8"))
        ));
        assertThrows(SecurityException.class, () -> PocketLinkDiscoveryPolicy.candidate(
                "Linux PC", "_http._tcp.", 8789, versionAttributes(),
                Collections.singletonList(InetAddress.getByName("10.0.0.8"))
        ));
        Map<String, byte[]> wrongVersion = new HashMap<>();
        wrongVersion.put("v", "2".getBytes(StandardCharsets.US_ASCII));
        assertThrows(SecurityException.class, () -> PocketLinkDiscoveryPolicy.candidate(
                "Linux PC", PocketLinkDiscoveryPolicy.SERVICE_TYPE, 8789, wrongVersion,
                Collections.singletonList(InetAddress.getByName("10.0.0.8"))
        ));
    }

    @Test
    public void discoveryBoundsNamesPortsAndAddressFanout() throws Exception {
        assertThrows(SecurityException.class, () -> PocketLinkDiscoveryPolicy.candidate(
                "x".repeat(61), PocketLinkDiscoveryPolicy.SERVICE_TYPE, 8789, versionAttributes(),
                Collections.singletonList(InetAddress.getByName("172.16.0.8"))
        ));
        assertThrows(SecurityException.class, () -> PocketLinkDiscoveryPolicy.candidate(
                "Linux\u202ePC", PocketLinkDiscoveryPolicy.SERVICE_TYPE, 8789, versionAttributes(),
                Collections.singletonList(InetAddress.getByName("172.16.0.8"))
        ));
        assertThrows(SecurityException.class, () -> PocketLinkDiscoveryPolicy.candidate(
                "Linux PC", PocketLinkDiscoveryPolicy.SERVICE_TYPE, 443, versionAttributes(),
                Collections.singletonList(InetAddress.getByName("172.16.0.8"))
        ));
        assertThrows(SecurityException.class, () -> PocketLinkDiscoveryPolicy.candidate(
                "Linux PC", PocketLinkDiscoveryPolicy.SERVICE_TYPE, 8789, versionAttributes(),
                Collections.nCopies(9, InetAddress.getByName("172.16.0.8"))
        ));
    }

    private static Map<String, byte[]> versionAttributes() {
        Map<String, byte[]> attributes = new HashMap<>();
        attributes.put("v", "1".getBytes(StandardCharsets.US_ASCII));
        return attributes;
    }
}
