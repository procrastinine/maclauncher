package com.maclauncher.android.macapk;

import java.lang.reflect.Array;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Device capabilities follow the selected driver and explicit capture policy. */
public final class Capabilities {
    private static final int GLES2 = 0x00020000;
    private static final int EGL_NONE = 0x3038;
    private static final int EGL_CONTEXT_MAJOR_VERSION = 0x3098;
    private static final int EGL_CONTEXT_MINOR_VERSION = 0x30fb;
    private static volatile int supportedGles;
    private static volatile long retryAfter;
    private static CompletableFuture<Integer> pendingProbe;

    private Capabilities() {}

    public static Object configuration(Object info) {
        if (info == null) return null;
        try { info.getClass().getField("reqGlEsVersion").setInt(info, glEsVersion()); }
        catch (ReflectiveOperationException failure) {
            throw new IllegalStateException("The Android graphics configuration is incompatible.", failure);
        }
        return info;
    }

    public static String property(String key, String value) {
        return "ro.opengles.version".equals(key) ? Integer.toString(glEsVersion()) : value;
    }

    public static void properties(Map<String, String> values) {
        values.put("ro.opengles.version", Integer.toString(glEsVersion()));
    }

    public static boolean feature(String name, boolean available) {
        return available && !captureFeature(name);
    }

    public static Object features(Object supplied) {
        if (supplied == null) return null;
        Class<?> component = supplied.getClass().getComponentType();
        if (component == null) throw new IllegalArgumentException("Expected Android feature information.");
        List<Object> retained = new ArrayList<>();
        try {
            for (int index = 0; index < Array.getLength(supplied); index++) {
                Object item = Array.get(supplied, index);
                if (item == null || !captureFeature((String) item.getClass().getField("name").get(item))) retained.add(item);
            }
        } catch (ReflectiveOperationException failure) {
            throw new IllegalStateException("The Android feature configuration is incompatible.", failure);
        }
        Object result = Array.newInstance(component, retained.size());
        for (int index = 0; index < retained.size(); index++) Array.set(result, index, retained.get(index));
        return result;
    }

    private static boolean captureFeature(String name) {
        return name != null && (name.equals("android.hardware.microphone") ||
            name.equals("android.hardware.camera") || name.startsWith("android.hardware.camera."));
    }

    public static int glEsVersion() {
        int cached = supportedGles;
        if (cached != 0) return cached;
        if (System.nanoTime() < retryAfter) return GLES2;
        CompletableFuture<Integer> pending;
        synchronized (Capabilities.class) {
            if (supportedGles != 0) return supportedGles;
            if (System.nanoTime() < retryAfter) return GLES2;
            if (pendingProbe == null || pendingProbe.isDone()) {
                pendingProbe = new CompletableFuture<>();
                CompletableFuture<Integer> result = pendingProbe;
                Thread worker = new Thread(() -> {
                    int observed = probeGles();
                    if (observed != 0) {
                        supportedGles = observed;
                        // The same observed level reaches native Android property
                        // readers through the runtime's existing property owner.
                        try { Class.forName("com.macapk.loader.NativeCocoa").getMethod("setSystemProperty", String.class, String.class)
                            .invoke(null, "ro.opengles.version", Integer.toString(observed)); }
                        catch (Throwable unavailable) {}
                    }
                    else retryAfter = System.nanoTime() + 250_000_000L;
                    result.complete(observed);
                }, "Android graphics capabilities");
                worker.setDaemon(true);
                worker.start();
            }
            pending = pendingProbe;
        }
        // A dedicated thread also keeps failed-context EGL error flags away
        // from the application's render thread. All callers share one probe.
        try { int observed = pending.get(2, TimeUnit.SECONDS); return observed == 0 ? GLES2 : observed; }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return GLES2; }
        catch (Exception unavailable) { return GLES2; }
    }

    private static int probeGles() {
        Class<?> egl;
        Object display = null;
        boolean initialized = false;
        try {
            // Reflection keeps package-only Java tools independent of native EGL
            // registration. No context is made current and no window is created.
            egl = Class.forName("android.opengl.EGL14");
            display = call(egl, "eglGetDisplay", 0);
            if (emptyHandle(display)) return 0;
            initialized = Boolean.TRUE.equals(call(egl, "eglInitialize", display, new int[1], 0, new int[1], 0));
            if (!initialized) return 0;
            Object configs = Array.newInstance(Class.forName("android.opengl.EGLConfig"), 1);
            int[] count = new int[1];
            // ES3-capable pbuffer config; a successful context allocation is the
            // capability proof. The active game's EGL state remains untouched.
            int[] attributes = {0x3040, 0x0040, 0x3033, 0x0001, 0x3024, 8, 0x3023, 8, 0x3022, 8, EGL_NONE};
            if (!Boolean.TRUE.equals(call(egl, "eglChooseConfig", display, attributes, 0, configs, 0, 1, count, 0)) || count[0] == 0) return GLES2;
            Object config = Array.get(configs, 0), none = egl.getField("EGL_NO_CONTEXT").get(null);
            for (int minor : new int[]{2, 1, 0}) {
                Object context = call(egl, "eglCreateContext", display, config, none,
                    new int[]{EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, minor, EGL_NONE}, 0);
                if (emptyHandle(context)) continue;
                try {
                    int[] major = new int[1], actualMinor = new int[1];
                    boolean majorRead = Boolean.TRUE.equals(call(egl, "eglQueryContext", display, context, EGL_CONTEXT_MAJOR_VERSION, major, 0));
                    boolean minorRead = Boolean.TRUE.equals(call(egl, "eglQueryContext", display, context, EGL_CONTEXT_MINOR_VERSION, actualMinor, 0));
                    if (majorRead && major[0] >= 3 && (minor == 0 || minorRead && actualMinor[0] >= minor)) return (3 << 16) | minor;
                } finally { call(egl, "eglDestroyContext", display, context); }
            }
            return GLES2;
        } catch (Throwable unavailable) {
            // Before native registration, retain upstream's known ES2 level and
            // retry later. Never promote a failed or unavailable driver probe.
            return 0;
        } finally {
            if (initialized) {
                try { call(Class.forName("android.opengl.EGL14"), "eglTerminate", display); }
                catch (Throwable ignored) {}
            }
        }
    }

    private static boolean emptyHandle(Object object) throws ReflectiveOperationException {
        return object == null || ((Number) object.getClass().getMethod("getNativeHandle").invoke(object)).longValue() == 0;
    }

    private static Object call(Class<?> owner, String name, Object... arguments) throws ReflectiveOperationException {
        for (Method method : owner.getMethods()) {
            if (!method.getName().equals(name) || method.getParameterCount() != arguments.length) continue;
            Class<?>[] types = method.getParameterTypes();
            boolean compatible = true;
            for (int index = 0; index < types.length; index++) {
                if (types[index] == int.class ? !(arguments[index] instanceof Integer) :
                    arguments[index] != null && !types[index].isInstance(arguments[index])) { compatible = false; break; }
            }
            if (compatible) return method.invoke(null, arguments);
        }
        throw new NoSuchMethodException(owner.getName() + "." + name);
    }
}
