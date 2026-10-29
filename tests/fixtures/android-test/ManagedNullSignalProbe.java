import android.app.NotificationChannel;
import dalvik.system.PathClassLoader;
import dalvik.system.VMRuntime;

/** Original boot-image code retains ART's managed-null signal handling while
 * an application has installed its own native crash handler. */
public final class ManagedNullSignalProbe {
    private static native void install();
    private static native int delivered();
    private static native void restore();
    private static native long invokeAot(NotificationChannel channel,java.lang.reflect.Method method,long[] pattern);
    public static void main(String[] args)throws Exception {
        VMRuntime.getRuntime().setTargetSdkVersion(36);
        ClassLoader loader=new PathClassLoader(args[1],new java.io.File(args[0]).getParent(),ClassLoader.getSystemClassLoader().getParent());
        Class.forName("ManagedNullSignalProbe",true,loader).getMethod("run",String.class).invoke(null,args[0]);
    }
    public static void run(String library)throws Exception {
        System.load(library);install();
        try {
            if(delivered()!=1)throw new AssertionError("Original native signal did not reach the application handler");
            if(android.os.Debug.isDebuggerConnected())throw new AssertionError("AOT dispatch proof requires no attached debugger");
            NotificationChannel channel=new NotificationChannel("fixture", "Fixture",3);
            java.lang.reflect.Method method=NotificationChannel.class.getMethod("setVibrationPattern",long[].class);
            channel.setVibrationPattern(new long[]{0,50});
            if(!channel.shouldVibrate())throw new AssertionError("Original non-null vibration pattern was lost");
            long entry=invokeAot(channel,method,new long[]{0,50});
            if(entry==0||!channel.shouldVibrate())throw new AssertionError("Original AOT non-null vibration pattern was lost");
            channel.setVibrationPattern(null);
            if(channel.shouldVibrate()||channel.getVibrationPattern()!=null)throw new AssertionError("Original null vibration pattern was lost");
            if(invokeAot(channel,method,null)!=entry||channel.shouldVibrate()||channel.getVibrationPattern()!=null)
                throw new AssertionError("Original AOT null vibration pattern or dispatch identity was lost");
            if(delivered()!=1)throw new AssertionError("Managed null reached the application's native signal handler");
            System.out.println("PASS original AOT NotificationChannel dispatch, null handling and application SIGSEGV chain in isolated PathClassLoader namespace");
        } finally { restore(); }
    }
}
