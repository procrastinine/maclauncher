import android.os.AsyncTask;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import maclauncher.android.framework.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public class AsyncTaskProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static void drainUntil(Looper main,java.util.function.BooleanSupplier condition)throws Exception{
        long limit=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);
        while(!condition.getAsBoolean()&&System.nanoTime()<limit){HostLooper.drain(main);Thread.sleep(1);}
        HostLooper.drain(main);check(condition.getAsBoolean(),"Callback deadline");
    }
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]).toRealPath(),data=Path.of(args[1]).toRealPath();
        Path files=Files.createDirectories(data.resolve("files")),cache=Files.createDirectories(data.resolve("cache"));
        HostFilesystem.configure(runtime,data,files,cache,"owned.tasks");
        System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
        System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(runtime.resolve("native/libnativebinding.dylib").toString());maclauncher.android.framework.HostProcessIdentity.initializeIds();
        JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();HostContext.hostPackage("owned.tasks","1",1);
        Looper main=HostLooper.main();Thread owner=Thread.currentThread();List<String> events=new ArrayList<>();
        AsyncTask<Integer,Integer,Integer> task=new AsyncTask<>(){
            protected void onPreExecute(){check(Thread.currentThread()==owner,"Pre owner");events.add("pre");}
            protected Integer doInBackground(Integer... values){check(Thread.currentThread()!=owner,"Background worker");publishProgress(values[0]);return values[0]*2;}
            protected void onProgressUpdate(Integer... values){check(Thread.currentThread()==owner,"Progress owner");events.add("progress:"+values[0]);}
            protected void onPostExecute(Integer value){check(Thread.currentThread()==owner,"Result owner");events.add("post:"+value);}
        };
        check(task.getStatus()==AsyncTask.Status.PENDING,"Pending initially");task.execute(7);check(task.get(2,TimeUnit.SECONDS)==14,"Actual background result");
        drainUntil(main,()->task.getStatus()==AsyncTask.Status.FINISHED);
        check(events.equals(List.of("pre","progress:7","post:14")),"Ordered owner callbacks");
        try{task.execute(2);throw new AssertionError("Task repeated");}catch(IllegalStateException expected){}
        for(boolean preFailure:new boolean[]{true,false}){
            var refused=new AsyncTask<Void,Void,Void>(){
                protected void onPreExecute(){if(preFailure)throw new IllegalStateException("pre failure");}
                protected Void doInBackground(Void... ignored){throw new AssertionError("Rejected task ran");}
                protected void onPostExecute(Void ignored){throw new AssertionError("Failed submission posted success");}
                protected void onCancelled(Void ignored){throw new AssertionError("Failed submission posted cancellation");}
            };
            try{refused.executeOnExecutor(r->{throw new RejectedExecutionException("executor full");});throw new AssertionError("Failed submission succeeded");}
            catch(IllegalStateException|RejectedExecutionException expected){}
            HostLooper.drain(main); // Original AOSP retains its RUNNING status after failed submission.
        }
        var entered=new CountDownLatch(1);var release=new CountDownLatch(1);var terminal=new AtomicInteger();
        AsyncTask<Void,Void,Integer> cancellation=new AsyncTask<>(){
            protected Integer doInBackground(Void... ignored){entered.countDown();boolean interrupted=false;for(;;)try{release.await();break;}catch(InterruptedException e){interrupted=true;}if(interrupted)Thread.currentThread().interrupt();return 9;}
            protected void onCancelled(Integer value){check(Thread.currentThread()==owner&&value==9,"Cancelled result after worker exits");terminal.incrementAndGet();}
            protected void onPostExecute(Integer value){throw new AssertionError("Cancelled task posted success");}
        };
        cancellation.executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR);check(entered.await(2,TimeUnit.SECONDS),"Worker entered");
        check(cancellation.cancel(true)&&cancellation.isCancelled(),"Cancellation state");
        try{cancellation.get();throw new AssertionError("Cancelled get succeeded");}catch(CancellationException expected){}
        HostLooper.drain(main);check(terminal.get()==0,"No completion while worker still owns result");release.countDown();
        drainUntil(main,()->terminal.get()==1);check(cancellation.getStatus()==AsyncTask.Status.FINISHED,"Cancellation completed once");
        CountDownLatch serialEntered=new CountDownLatch(1),serialRelease=new CountDownLatch(1);
        AsyncTask.execute(()->{serialEntered.countDown();try{serialRelease.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}});
        check(serialEntered.await(2,TimeUnit.SECONDS),"Serial worker occupied");
        var skipped=new AsyncTask<Void,Void,Void>(){protected Void doInBackground(Void... values){throw new AssertionError("Cancelled queued task ran");}protected void onCancelled(Void value){terminal.incrementAndGet();}};
        skipped.execute();check(skipped.cancel(false),"Queued cancel");drainUntil(main,()->terminal.get()==2);serialRelease.countDown();
        var thread=new HandlerThread("priority-handler",android.os.Process.THREAD_PRIORITY_BACKGROUND);
        check(thread.getLooper()==null&&thread.getThreadId()==-1,"Unstarted thread identity");thread.start();
        var background=new Handler(Objects.requireNonNull(thread.getLooper()));var delivered=new CountDownLatch(1);var failure=new AtomicReference<Throwable>();
        background.post(()->{try{check(android.os.Process.myTid()==thread.getThreadId(),"Actual native thread ID");check(android.os.Process.getThreadPriority(0)==10,"Actual Darwin background priority");}catch(Throwable error){failure.set(error);}finally{delivered.countDown();}});
        check(delivered.await(2,TimeUnit.SECONDS),"Handler callback");if(failure.get()!=null)throw new AssertionError(failure.get());
        check(thread.quitSafely(),"Safe quit accepted");thread.join(2000);check(!thread.isAlive()&&thread.getThreadId()==-1&&thread.getLooper()==null,"Thread and queue retired");
        CountDownLatch shutdownEntered=new CountDownLatch(1),shutdownExited=new CountDownLatch(1);
        AsyncTask.THREAD_POOL_EXECUTOR.execute(()->{shutdownEntered.countDown();try{new CountDownLatch(1).await();}catch(InterruptedException expected){shutdownExited.countDown();}});
        check(shutdownEntered.await(2,TimeUnit.SECONDS),"Shutdown worker entered");
        var undelivered=new AsyncTask<Void,Void,Integer>(){protected Integer doInBackground(Void... values){return 1;}protected void onPostExecute(Integer result){throw new AssertionError("Callback delivered after owner quit");}};
        undelivered.executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR);check(undelivered.get(2,TimeUnit.SECONDS)==1,"Pending callback has completed work");
        check(undelivered.getStatus()==AsyncTask.Status.RUNNING,"Completion is still queued");HostLooper.close(main);
        check(!new Handler(main).post(()->{throw new AssertionError("Closed queue callback");}),"Owner queue drops callbacks after closure");
        check(shutdownExited.await(2,TimeUnit.SECONDS),"Application shutdown interrupts its executor workers");
        try{AsyncTask.execute(()->{});throw new AssertionError("Closed owner accepted work");}catch(RejectedExecutionException expected){}
        System.out.println("PASS background tasks, cancellation, actual HandlerThread priority and owner shutdown");
    }
}
