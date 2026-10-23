import java.nio.file.Path;
import java.util.HashSet;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import maclauncher.android.bridge.NativeBinding;

public final class JniThreadPointerProbe {
    private static native int state();
    private static native long pointer();
    public static void main(String[] args)throws Exception {
        Path core=Path.of(args[0]),binding=Path.of(args[1]),guest=Path.of(args[2]);
        System.load(core.toString());System.load(binding.toString());
        maclauncher.android.framework.HostProcessIdentity.initializeIds();
        AtomicReference<Throwable> failure=new AtomicReference<>();
        Thread loading=new Thread(()->{
            try{
                long image=NativeBinding.load(core.toString(),guest.toString(),"libjni-thread-pointer.so");
                NativeBinding.bind(image,JniThreadPointerProbe.class);
                if(state()!=7)throw new AssertionError("Constructor/JNI_OnLoad/JNI thread pointer is uninitialized");
            }catch(Throwable error){failure.set(error);}
        },"original-constructor-onload");
        loading.start();loading.join(5000);
        if(loading.isAlive())throw new AssertionError("Native loading did not retire");
        if(failure.get()!=null)throw new AssertionError("Original native entry",failure.get());
        long main=pointer();
        if(main==0||main!=pointer())throw new AssertionError("First main JNI entry must retain its thread pointer");
        CountDownLatch ready=new CountDownLatch(4),release=new CountDownLatch(1);
        Thread[] workers=new Thread[4];long[] pointers=new long[4];
        for(int i=0;i<workers.length;i++){
            final int at=i;
            workers[i]=new Thread(()->{
                try{
                    pointers[at]=pointer();
                    if(pointers[at]==0||pointers[at]!=pointer())throw new AssertionError("Fresh JNI thread pointer");
                }catch(Throwable error){failure.compareAndSet(null,error);}
                finally{ready.countDown();}
                try{release.await();}catch(InterruptedException error){failure.compareAndSet(null,error);}
            },"original-jni-worker-"+i);
            workers[i].start();
        }
        if(!ready.await(5,java.util.concurrent.TimeUnit.SECONDS))throw new AssertionError("Fresh JNI entries did not complete");
        release.countDown();for(Thread worker:workers){worker.join(5000);if(worker.isAlive())throw new AssertionError("JNI worker did not retire");}
        if(failure.get()!=null)throw new AssertionError("Original JNI worker",failure.get());
        HashSet<Long> distinct=new HashSet<>();distinct.add(main);
        for(long value:pointers)if(!distinct.add(value))throw new AssertionError("Live threads shared an Android TP");
        System.out.println("PASS original ELF constructor, JNI_OnLoad, main/four fresh registered JNI threads and retirement retain Android TP and canary");
    }
}
