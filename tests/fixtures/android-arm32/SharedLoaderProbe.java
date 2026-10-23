import maclauncher.android.bridge.NativeBinding;
public final class SharedLoaderProbe {
    private static native int value();
    private static native int narrowByte(byte value);
    private static native int narrowShort(short value);
    private static native int narrowChar(char value);
    private static native int narrowBoolean(boolean value);
    private static native void finish();
    private static native boolean legacyTables();
    private static native boolean imageAddress();
    private static native boolean allocations();
    private static native boolean jumps();
    private static native boolean searches();
    private static native void exitThread();
    public static void main(String[] args) throws Exception {
        System.load(args[0]);
        maclauncher.android.framework.HostProcessIdentity.initializeIds();
        System.load(args[1]);
        long image=NativeBinding.load(args[0],args[2],"libshared32.so");
        if(image==0 || (image&1)!=0)throw new AssertionError("shared image handle");
        NativeBinding.bind(image,SharedLoaderProbe.class);
        for (int value : new int[] {-128, -1, 0, 1, 127})
            if (narrowByte((byte)value) != value)
                throw new AssertionError("AAPCS32 signed byte argument: " + value + " became " + narrowByte((byte)value));
        for (int value : new int[] {-32768, -1, 0, 1, 32767})
            if (narrowShort((short)value) != value)
                throw new AssertionError("AAPCS32 signed short argument: " + value + " became " + narrowShort((short)value));
        if (narrowChar('\uffff') != 65535 || narrowBoolean(true) != 1 || narrowBoolean(false) != 0)
            throw new AssertionError("AAPCS32 unsigned narrow arguments");
        if(value()!=1)throw new AssertionError("ELF32 constructor did not run once");
        long again=NativeBinding.load(args[0],args[2],"libshared32.so");
        if(again!=image || value()!=1)throw new AssertionError("duplicate image or constructor owner");
        if(!legacyTables())throw new AssertionError("original Bionic legacy ctype data and pointer relocations");
        if(!imageAddress())throw new AssertionError("guest code addresses use the original shared image registry");
        if(!allocations())throw new AssertionError("original Bionic C++ allocation family shares native memory ownership");
        if(!jumps())throw new AssertionError("original ARM32 nonlocal jumps preserve guest CPU state and nested buffers");
        if(!searches())throw new AssertionError("original ARM32 search structures retain guest pointer width and callbacks");
        var resumed=new java.util.concurrent.atomic.AtomicBoolean();
        var failure=new java.util.concurrent.atomic.AtomicReference<Throwable>();
        var worker=new Thread(()->{exitThread();resumed.set(true);},"ARM32-managed-exit");
        worker.setUncaughtExceptionHandler((thread,error)->failure.set(error));
        worker.start();worker.join(5000);
        if(worker.isAlive() || resumed.get() || !(failure.get() instanceof ThreadDeath))
            throw new AssertionError("ARM32 pthread_exit must unwind through the original JVM thread owner",failure.get());
        finish();finish();
        if(value()!=8)throw new AssertionError("original AEABI lifecycle must invoke the shared DSO owner once");
        System.out.println("PASS ELF32 uses original NativeBinding image identity and constructor owner");
    }
}
