package maclauncher.android.fixture;

import android.os.SystemClock;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.*;

/** Original AOSP native alarm methods over the runtime's shared descriptors. */
public final class AlarmNativeProbe {
    private static Method method(String name,Class<?>... arguments)throws Exception {
        var method=Class.forName("com.android.server.alarm.AlarmManagerService").getDeclaredMethod(name,arguments);
        method.setAccessible(true);return method;
    }
    private static long descriptors()throws Exception {try(var entries=Files.list(Path.of("/dev/fd"))){return entries.count();}}
    private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception {
        RuntimeFixture.initialize(args[0],args[1],args[2]);
        var init=method("init");var close=method("close",long.class);
        var set=method("set",long.class,int.class,long.class,long.class);
        var next=method("getNextAlarm",long.class,int.class);
        var wait=method("waitForAlarm",long.class);
        long baseline=descriptors();
        for(int type=0;type<5;type++) {
            long owner=(long)init.invoke(null);check(owner!=0,"Original alarm initialization");
            ExecutorService worker=Executors.newSingleThreadExecutor();
            try {
                long now=type<2?System.currentTimeMillis():type==4?SystemClock.uptimeMillis():SystemClock.elapsedRealtime();
                long deadline=now+180;
                check((int)set.invoke(null,owner,type,deadline/1000,(deadline%1000)*1_000_000)==0,"Arm original clock "+type);
                long remaining=(long)next.invoke(null,owner,type);
                check(remaining>=0&&remaining<=180,"Original remaining time "+type+": "+remaining);
                long start=System.nanoTime();
                Future<Integer> delivered=worker.submit(()->(int)wait.invoke(null,owner));
                int mask=delivered.get(3,TimeUnit.SECONDS);
                check((mask&(1<<type))!=0,"Original alarm type mask "+type+": "+mask);
                long elapsed=(System.nanoTime()-start)/1_000_000;
                check(elapsed>=80&&elapsed<1500,"Clock domain/wait "+type+": "+elapsed);
                check((long)next.invoke(null,owner,type)==0,"One-shot timer retired "+type);
                check((int)set.invoke(null,owner,8,0L,1L)==22,"Android errno representation");
            } finally {worker.shutdownNow();close.invoke(null,owner);}
        }
        // Initialization also creates the original realtime-change descriptor.
        // All six timerfds and their epoll owner must retire on every close.
        for(int i=0;i<24;i++){long owner=(long)init.invoke(null);check(owner!=0,"Repeated init");close.invoke(null,owner);}
        check(descriptors()<=baseline,"Alarm descriptors survived teardown");
        System.out.println("PASS original alarm JNI clocks, masks, errno and descriptor lifetime");
        System.exit(0);
    }
}
