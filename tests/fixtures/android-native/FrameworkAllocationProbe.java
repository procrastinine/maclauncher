import java.lang.management.*;
import java.lang.ref.*;
import java.nio.file.*;
import java.util.concurrent.*;
import libcore.util.NativeAllocationRegistry;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.FrameworkResources;
import maclauncher.android.framework.HostApplication;

public final class FrameworkAllocationProbe {
    static native long allocate(); static native long freeFunction(); static native int released();
    static BufferPoolMXBean pool;
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static long[] memory(){return new long[]{pool.getCount(),pool.getTotalCapacity(),pool.getMemoryUsed()};}
    static void balanced(long[] baseline){long[] actual=memory();check(java.util.Arrays.equals(baseline,actual),"JVM budget not balanced: baseline="+java.util.Arrays.toString(baseline)+", actual="+java.util.Arrays.toString(actual));}
    static WeakReference<Object> unreachable(NativeAllocationRegistry registry){
        Object owner=new Object();registry.registerNativeAllocation(owner,allocate());return new WeakReference<>(owner);
    }
    public static void main(String[] args)throws Exception {
        System.setProperty("core_native_classes","preserved-original");
        RuntimeFixture.initialize(args[0],args[1],args[2]);
        System.out.println("BEGIN native allocation operations");
        System.out.flush();
        long callback=freeFunction();
        NativeAllocationRegistry.applyFreeFunction(callback,allocate());
        check(released()==1,"upstream native callback was not called");
        check(System.getProperty("core_native_classes").equals("preserved-original"),"loader changed properties");
        pool=ManagementFactory.getPlatformMXBeans(BufferPoolMXBean.class).stream().filter(p->p.getName().equals("direct")).findFirst().orElseThrow();
        // The deliberate OOM below collects unrelated startup allocations too.
        // Drain those cleaners before taking the exact accounting baseline.
        System.gc();Thread.sleep(100);
        long[] baseline=memory();Object owner=new Object();
        var malloced=NativeAllocationRegistry.createMalloced(FrameworkAllocationProbe.class,callback,64);
        Runnable cleanup=malloced.registerNativeAllocation(owner,allocate());
        check(pool.getTotalCapacity()==baseline[1]+64&&pool.getMemoryUsed()==baseline[2]+64&&pool.getCount()==baseline[0]+1,"malloc estimate not reserved in JVM budget");
        Thread[] threads=new Thread[4];
        for(int i=0;i<threads.length;i++){threads[i]=new Thread(()->{for(int n=0;n<20;n++)cleanup.run();});threads[i].start();}
        for(Thread thread:threads)thread.join();
        check(released()==2,"concurrent/double cleanup did not free exactly once");balanced(baseline);
        var nonmalloced=new NativeAllocationRegistry(FrameworkAllocationProbe.class.getClassLoader(),callback,66);
        Runnable direct=nonmalloced.registerNativeAllocation(owner,allocate());
        check(pool.getTotalCapacity()==baseline[1]+66,"non-malloc estimate not reserved");direct.run();balanced(baseline);
        var zero=NativeAllocationRegistry.createMalloced(FrameworkAllocationProbe.class,callback,0);
        Runnable empty=zero.registerNativeAllocation(owner,allocate());
        check(pool.getCount()==baseline[0]+1,"zero-sized registry lost ownership");empty.run();balanced(baseline);
        int before= released();
        var tooLarge=NativeAllocationRegistry.createMalloced(FrameworkAllocationProbe.class,callback,256L*1024*1024);
        try{tooLarge.registerNativeAllocation(owner,allocate());throw new AssertionError("JVM native-memory budget accepted allocation over its limit");}
        catch(OutOfMemoryError expected){check(expected.getMessage().contains("direct buffer memory"),"wrong OOM: "+expected);}
        check(released()==before+1,"AOSP OOM cleanup did not free supplied pointer exactly once");balanced(baseline);
        int beforeGc=released();WeakReference<Object> weak=unreachable(malloced);
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        while((weak.get()!=null||released()==beforeGc)&&System.nanoTime()<deadline){System.gc();Thread.sleep(20);}
        check(weak.get()==null&&released()==beforeGc+1,"JDK Cleaner did not collect/free unreachable allocation");balanced(baseline);
        Reference.reachabilityFence(owner);
        HostApplication.shutdown();FrameworkResources.shutdown();
        System.out.println("PASS actual upstream native free, JDK accounting, concurrent cleanup, OOM cleanup and collection");
        System.exit(0);
    }
}
