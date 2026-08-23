package io.github.jaemanlee.codexpocketvoice;

import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class PocketLinkDiscoveryPolicy {
    static final String SERVICE_TYPE = "_codexpocket._tcp.";
    static final int MAX_CANDIDATES = 16;
    static final int MAX_PENDING_SERVICES = 32;
    static final int MAX_SEEN_SERVICES = 64;
    static final int MAX_ADDRESSES = 8;

    private PocketLinkDiscoveryPolicy() {}

    static Candidate candidate(
            String serviceName,
            String serviceType,
            int port,
            Map<String, byte[]> attributes,
            List<InetAddress> addresses
    ) {
        String name = normalizedName(serviceName);
        if (!canonicalServiceType(serviceType).equals(SERVICE_TYPE)) {
            throw new SecurityException("PocketLink discovery service type이 올바르지 않습니다.");
        }
        if (port < 1_024 || port > 65_535) {
            throw new SecurityException("PocketLink discovery port가 올바르지 않습니다.");
        }
        if (attributes == null || attributes.size() != 1 || !attributes.containsKey("v")) {
            throw new SecurityException("PocketLink discovery TXT record가 올바르지 않습니다.");
        }
        byte[] version = attributes.get("v");
        if (version == null || !"1".equals(new String(version, StandardCharsets.US_ASCII))) {
            throw new SecurityException("PocketLink discovery protocol version을 지원하지 않습니다.");
        }
        if (addresses == null || addresses.isEmpty() || addresses.size() > MAX_ADDRESSES) {
            throw new SecurityException("PocketLink discovery address 목록이 올바르지 않습니다.");
        }
        InetAddress selected = selectAddress(addresses);
        if (selected == null) {
            throw new SecurityException("PocketLink discovery가 사설 LAN 주소를 제공하지 않았습니다.");
        }
        return new Candidate(name, selected.getHostAddress(), port);
    }

    static String canonicalServiceType(String value) {
        if (value == null) return "";
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        return normalized.endsWith(".") ? normalized : normalized + ".";
    }

    private static String normalizedName(String value) {
        String name = value == null ? "" : Normalizer.normalize(value, Normalizer.Form.NFC).trim();
        if (name.isEmpty() || name.length() > 60) {
            throw new SecurityException("PocketLink discovery PC 이름이 올바르지 않습니다.");
        }
        for (int index = 0; index < name.length();) {
            int item = name.codePointAt(index);
            int type = Character.getType(item);
            if (type == Character.CONTROL || type == Character.FORMAT) {
                throw new SecurityException("PocketLink discovery PC 이름이 올바르지 않습니다.");
            }
            index += Character.charCount(item);
        }
        return name;
    }

    private static InetAddress selectAddress(List<InetAddress> addresses) {
        for (InetAddress address : addresses) {
            if (address instanceof Inet4Address && isPrivateAddress(address)) return address;
        }
        for (InetAddress address : addresses) {
            if (address instanceof Inet6Address && isPrivateAddress(address)) return address;
        }
        return null;
    }

    private static boolean isPrivateAddress(InetAddress address) {
        if (address == null || address.isAnyLocalAddress() || address.isLoopbackAddress()
                || address.isMulticastAddress()) return false;
        byte[] bytes = address.getAddress();
        if (address instanceof Inet4Address && bytes.length == 4) {
            int first = bytes[0] & 0xff;
            int second = bytes[1] & 0xff;
            return first == 10
                    || (first == 172 && second >= 16 && second <= 31)
                    || (first == 192 && second == 168)
                    || (first == 169 && second == 254);
        }
        return address instanceof Inet6Address && bytes.length == 16 && (bytes[0] & 0xfe) == 0xfc;
    }

    static final class Candidate {
        final String name;
        final String host;
        final int port;

        Candidate(String name, String host, int port) {
            this.name = name;
            this.host = host;
            this.port = port;
        }

        String key() {
            return name + "\u0000" + host + "\u0000" + port;
        }
    }
}
