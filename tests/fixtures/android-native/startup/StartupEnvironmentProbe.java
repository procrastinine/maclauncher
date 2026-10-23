package maclauncher.android.framework;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Base64;

/** Exercises the compiled startup parser and getters without configuring an Android VM. */
public final class StartupEnvironmentProbe {
    private static int checks;

    private static void require(boolean value, String description) {
        checks++;
        if (!value) throw new AssertionError(description);
    }

    private static String packet(byte[] bytes) {
        return "1:" + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static String packet(String text) {
        return packet(text.getBytes(StandardCharsets.UTF_8));
    }

    private static void rejected(String value) {
        try {
            HostNativeStartup.decode(value);
            throw new AssertionError("Malformed startup vector accepted");
        } catch (IllegalStateException expected) {
            require("Invalid Android native startup environment".equals(expected.getMessage()), "Short parser error");
        }
    }

    private static Field field(String name) throws Exception {
        Field value = HostContext.class.getDeclaredField(name);
        value.setAccessible(true);
        return value;
    }

    public static void main(String[] args) throws Exception {
        Path jar = Path.of(args[0]).toRealPath();
        require(Path.of(HostNativeStartup.class.getProtectionDomain().getCodeSource().getLocation().toURI()).toRealPath().equals(jar), "Actual decoder JAR");
        require(Path.of(HostContext.class.getProtectionDomain().getCodeSource().getLocation().toURI()).toRealPath().equals(jar), "Actual getter JAR");
        require(HostNativeStartup.decode("1:").length == 0, "Explicit empty environment");
        require(Arrays.equals(HostNativeStartup.decode(packet("EMPTY=\0TEXT=é 🧩\nnext=value\0")), new String[]{"EMPTY=", "TEXT=é 🧩\nnext=value"}), "UTF-8, empty, newline and equals values");

        for (String value : new String[]{null, "", "1", "0:", "2:", "01:", "1:=", "1:QQ==", "1:+w", "1:/w", "1:A", "1:QR", "1:AA\0"}) rejected(value);
        for (String value : new String[]{"A=value", "\0", "A=x\0\0", "\0A=x\0", "A=x\0B=y", "A=x\0bare\0", "=v\0", "9KEY=v\0", "A-B=v\0", "A B=v\0", "A\nB=v\0", "é=v\0", "A=one\0A=two\0"}) rejected(packet(value));
        rejected(packet(new byte[]{'A', '=', (byte)0xc3, 0x28, 0}));
        rejected(packet(new byte[]{'A', '=', (byte)0xc0, (byte)0x80, 0}));
        rejected(packet(new byte[]{'A', '=', (byte)0xed, (byte)0xa0, (byte)0x80, 0}));

        StringBuilder entries = new StringBuilder();
        for (int i = 0; i < 64; i++) entries.append("V").append(i).append("=\0");
        require(HostNativeStartup.decode(packet(entries.toString())).length == 64, "Exact entry limit");
        rejected(packet(entries + "LAST=\0"));
        String boundary = "A=" + "é".repeat(8190) + "a\0";
        require(boundary.getBytes(StandardCharsets.UTF_8).length == 16384, "Exact fixture byte size");
        require(HostNativeStartup.decode(packet(boundary))[0].length() == boundary.length() - 1, "Exact UTF-8 byte limit accepted");
        rejected(packet("A=" + "é".repeat(8190) + "aa\0"));
        rejected(packet(boundary + "B=\0"));

        String[] expected = {"EMPTY=", "HOME=/guest/home", "LANG=é 🧩", "LINE=first\nnext=value", "PATH=/usr/bin:/bin"};
        String[] first = HostContext.hostNativeStartupEnvironment();
        require(Arrays.equals(first, expected), "Launcher encoding accepted without ambient additions");
        require("synthetic-secret".equals(System.getenv("ANDROID_STARTUP_TEST_SECRET")), "Ambient sentinel exists");
        require("synthetic-control".equals(System.getenv("KL_TEST_CONTROL")), "Host control sentinel exists");
        require("synthetic-identity".equals(System.getenv("MACLAUNCHER_TEST_IDENTITY")), "Host identity sentinel exists");
        String[] second = HostContext.hostNativeStartupEnvironment();
        require(first != second && Arrays.equals(first, second), "Independent environment clones");
        first[0] = "CHANGED=fixture";
        require(Arrays.equals(HostContext.hostNativeStartupEnvironment(), expected), "Caller mutation cannot change cached environment");

        Field packageName = field("packageName"), processName = field("processName");
        packageName.set(null, null);
        processName.set(null, null);
        try {
            HostContext.hostNativeStartupArguments();
            throw new AssertionError("Unconfigured process accepted");
        } catch (IllegalStateException expectedFailure) {
            require(expectedFailure.getMessage().contains("not been configured"), "Unconfigured getter fails");
        }
        packageName.set(null, "org.example.startup");
        require(Arrays.equals(HostContext.hostNativeStartupArguments(), new String[]{"org.example.startup"}), "Configured package fallback");
        processName.set(null, "org.example.startup:worker");
        String[] invocation = HostContext.hostNativeStartupArguments();
        require(Arrays.equals(invocation, new String[]{"org.example.startup:worker"}), "Exact configured process, no host JVM arguments");
        invocation[0] = "changed";
        require(Arrays.equals(HostContext.hostNativeStartupArguments(), new String[]{"org.example.startup:worker"}), "Independent argument array");
        processName.set(null, "org.example.startup\0injected");
        try {
            HostContext.hostNativeStartupArguments();
            throw new AssertionError("Invalid configured process accepted");
        } catch (IllegalArgumentException expectedFailure) {
            require(true, "Process name validation");
        }
        System.out.println("PASS actual startup decoder: " + checks + " checks; cached environment clones; configured process argv");
    }
}
