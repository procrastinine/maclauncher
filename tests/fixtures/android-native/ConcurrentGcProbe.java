import dalvik.system.VMRuntime;
import java.lang.management.ManagementFactory;
import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

public final class ConcurrentGcProbe {
    private static long collections() {
        return ManagementFactory.getGarbageCollectorMXBeans().stream()
                .mapToLong(value->Math.max(0,value.getCollectionCount())).sum();
    }
    private static WeakReference<Object> garbage(ReferenceQueue<Object> queue) {
        return new WeakReference<>(new byte[1024*1024],queue);
    }
    public static void main(String[] arguments) throws Exception {
        System.load(arguments[0]);
        var queue=new ReferenceQueue<Object>();
        var reference=garbage(queue);
        long before=collections();
        var start=new CountDownLatch(1);
        var callers=new ArrayList<Thread>();
        var failures=new java.util.concurrent.ConcurrentLinkedQueue<Throwable>();
        for(int thread=0;thread<8;thread++) callers.add(Thread.ofPlatform().start(()->{
            try { start.await();for(int i=0;i<1000;i++)VMRuntime.getRuntime().requestConcurrentGC(); }
            catch(Throwable failure){failures.add(failure);}
        }));
        start.countDown();
        for(var caller:callers)caller.join();
        if(!failures.isEmpty())throw new AssertionError("Original VMRuntime request failed",failures.peek());
        if(queue.remove(5000)!=reference||reference.get()!=null||collections()<=before)
            throw new AssertionError("The original Android request did not reach the JVM collector");
        var owner=Class.forName("maclauncher.android.framework.JvmNativeMemory$Collector");
        var field=owner.getDeclaredField("worker");field.setAccessible(true);
        var worker=(ThreadPoolExecutor)field.get(null);
        if(worker.getLargestPoolSize()!=1||worker.getQueue().size()>1)
            throw new AssertionError("Collection requests accumulated workers or queued tasks");
        worker.setKeepAliveTime(50,TimeUnit.MILLISECONDS);
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);
        while(worker.getPoolSize()!=0&&System.nanoTime()<deadline)Thread.sleep(10);
        if(worker.getPoolSize()!=0)throw new AssertionError("Idle collection worker did not retire");
        System.out.println("PASS original VMRuntime reaches JVM collection with coalesced requests and idle cleanup");
    }
}
