import android.os.Process;
import com.android.server.ServiceThread;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import maclauncher.android.fixture.RuntimeFixture;

public final class ServiceThreadPriorityProbe {
    private static native void install();
    public static void main(String[] args)throws Exception {
        RuntimeFixture.initialize(args[0],args[1]);
        System.load(args[2]);install();
        var completed=new CountDownLatch(1);var failure=new AtomicReference<Throwable>();
        var worker=new ServiceThread("original-background-service",Process.THREAD_PRIORITY_BACKGROUND,true){
            @Override protected void onLooperPrepared(){
                try{if(Process.getThreadPriority(Process.myTid())!=Process.THREAD_PRIORITY_BACKGROUND)throw new AssertionError("Original worker did not receive background priority");}
                catch(Throwable error){failure.set(error);}
                finally{getLooper().quitSafely();completed.countDown();}
            }
        };
        worker.setUncaughtExceptionHandler((thread,error)->{failure.set(error);completed.countDown();});
        worker.start();
        if(!completed.await(5,TimeUnit.SECONDS))throw new AssertionError("Original service worker did not enter its Looper");
        worker.join(5000);
        if(failure.get()!=null)throw new AssertionError("Original ServiceThread bootstrap failed",failure.get());
        if(worker.isAlive())throw new AssertionError("Original service worker did not retire");
        System.out.println("PASS original ServiceThread background priority and Looper lifecycle");
        System.exit(0);
    }
}
