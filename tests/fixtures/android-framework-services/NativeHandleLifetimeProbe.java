import maclauncher.android.framework.HostNativeHandle;
import java.util.concurrent.atomic.AtomicInteger;

public final class NativeHandleLifetimeProbe {
    private static native void finalizeHandle(long function,long handle);
    private static void check(boolean condition){if(!condition)throw new AssertionError();}
    private static void absent(long handle){try{HostNativeHandle.state(handle);throw new AssertionError("Retired identity resolved");}catch(IllegalStateException expected){}}
    public static void main(String[] args)throws Exception{
        System.load(args[0]);long finalizer=HostNativeHandle.finalizer();AtomicInteger closed=new AtomicInteger();
        AutoCloseable original=closed::incrementAndGet;long old=HostNativeHandle.create(original);
        check(HostNativeHandle.retain(old)==old);HostNativeHandle.release(old);check(closed.get()==0&&HostNativeHandle.state(old)==original);
        finalizeHandle(finalizer,old);check(closed.get()==1);absent(old);
        AutoCloseable replacement=closed::incrementAndGet;long current=HostNativeHandle.create(replacement);check(current!=old);
        // The native fixture uses exactly the same allocation address for both
        // owners. Neither a delayed release nor the original finalizer can
        // retire or resolve the replacement's reused allocation.
        HostNativeHandle.release(old);finalizeHandle(finalizer,old);absent(old);
        check(closed.get()==1&&HostNativeHandle.state(current)==replacement);
        check(HostNativeHandle.retain(current)==current);HostNativeHandle.release(current);check(closed.get()==1);
        finalizeHandle(finalizer,current);check(closed.get()==2);absent(current);
        finalizeHandle(finalizer,current);check(closed.get()==2);
        System.out.println("PASS forced native allocation reuse preserves shared ownership and rejects stale release/finalizer identities");
    }
}
