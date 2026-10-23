package io.maclauncher.steam;

import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.Properties;

/** Loads a reviewed JNI counterpart before the unchanged game's main method.
 * The game retains ownership of Steam initialization, callbacks and shutdown. */
public final class MacLauncherSteamAgent {
    private MacLauncherSteamAgent() { }

    public static void premain(String configuration, Instrumentation instrumentation) {
        try {
            load(configuration);
        } catch (Throwable failure) {
            while (failure instanceof InvocationTargetException && failure.getCause() != null) {
                failure = failure.getCause();
            }
            // Escaping premain causes a libinstrument fatal abort/crash dialog.
            // A normal process exit leaves the launcher able to report failure.
            System.err.println("MacLauncher: Java Steam bridge could not load: " + failure.getMessage());
            System.exit(78);
        }
    }

    private static void load(String configuration) throws Exception {
        Properties properties = new Properties();
        try (Reader reader = new InputStreamReader(new FileInputStream(configuration), StandardCharsets.UTF_8)) {
            properties.load(reader);
        }
        final String required = properties.getProperty("version");
        final String helper = properties.getProperty("helper");
        final String jni = properties.getProperty("jni");
        String cpu = System.getProperty("os.arch");
        String actualCpu = (cpu.equals("aarch64") || cpu.equals("arm64")) ? "arm64"
            : (cpu.equals("amd64") || cpu.equals("x86_64")) ? "x64" : "unknown";
        if (!actualCpu.equals(properties.getProperty("arch"))) {
            throw new IllegalArgumentException("The native Steam bridge and JVM CPUs differ.");
        }
        Class<?> versionClass = Class.forName("com.codedisaster.steamworks.Version");
        String actual = String.valueOf(versionClass.getMethod("getVersion").invoke(null));
        if (!actual.equals(required)) throw new IllegalArgumentException("The original steamworks4j version changed.");
        final Class<?> api = Class.forName("com.codedisaster.steamworks.SteamAPI");
        if (required.equals("1.9.0")) {
            if (!actualCpu.equals("x64") || api.getDeclaredMethod("nativeInit").getReturnType() != Boolean.TYPE) {
                throw new IllegalArgumentException("The legacy JNI ABI changed.");
            }
            System.load(helper);
            System.load(jni);
            api.getMethod("skipLoadLibraries").invoke(null);
        } else if (required.equals("1.10.0")) {
            if (api.getDeclaredMethod("nativeInit").getReturnType() != Integer.TYPE) {
                throw new IllegalArgumentException("The current JNI ABI changed.");
            }
            final Class<?> type = Class.forName("com.codedisaster.steamworks.SteamLibraryLoader");
            Object loader = Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] { type }, new InvocationHandler() {
                public Object invoke(Object proxy, Method method, Object[] arguments) {
                    if (method.getName().equals("loadLibrary")) {
                        String name = (String) arguments[0];
                        if (!name.equals("steam_api") && !name.equals("steamworks4j")) {
                            throw new IllegalArgumentException("Unexpected native library.");
                        }
                        System.load(name.equals("steam_api") ? helper : jni);
                        return Boolean.TRUE;
                    }
                    if (method.getName().equals("toString")) return "MacLauncherSteamLoader";
                    if (method.getName().equals("hashCode")) return System.identityHashCode(proxy);
                    if (method.getName().equals("equals")) return proxy == arguments[0];
                    return null;
                }
            });
            if (!Boolean.TRUE.equals(api.getMethod("loadLibraries", type).invoke(null, loader))) {
                throw new IllegalStateException("The native Steam bridge could not load.");
            }
        } else {
            throw new IllegalArgumentException("This steamworks4j version has no qualified native bridge.");
        }
    }
}
