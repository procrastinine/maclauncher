package maclauncher.android.fixture;

import android.os.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import maclauncher.android.framework.*;

public final class LazyServiceRetirementProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
    static void run(String[] args)throws Exception{
        var loop=RuntimeFixture.initialize(args[0],args[1]);
        ownerExecution();
        String original="fixture.lazy.original-publication";
        HostServices.registerLazy(original,IServiceManager.DESCRIPTOR,()->{
            try{HostServices.manager().addService(original,HostServices.manager().asBinder(),false,0);}
            catch(RemoteException failure){throw new AssertionError(failure);}
            return HostServices.manager();
        },true);
        check(HostServices.publishedManager().checkService(original)==HostServices.manager().asBinder(),
            "first lookup returns the Binder published by original onStart inside its factory");
        HostServices.unregister(original,HostServices.manager(),IServiceManager.DESCRIPTOR);
        String name="fixture.lazy.retirement";
        var entered=new CountDownLatch(1);var finish=new CountDownLatch(1);
        HostServices.registerLazy(name,IServiceManager.DESCRIPTOR,()->{
            check(Thread.currentThread().getName().equals("Lazy service lookup"),"default lazy construction remains on the requesting worker");
            entered.countDown();try{if(!finish.await(2,TimeUnit.SECONDS))throw new AssertionError("factory release timeout");}
            catch(InterruptedException interrupted){throw new AssertionError(interrupted);}
            return HostServices.manager();
        });
        var lookup=new FutureTask<IBinder>(()->HostServices.manager().checkService(name));
        var worker=new Thread(lookup,"Lazy service lookup");worker.start();
        check(entered.await(2,TimeUnit.SECONDS),"factory started");
        HostServices.unregisterLazy(name);
        finish.countDown();check(lookup.get(2,TimeUnit.SECONDS)==null,"retired factory cannot return a published service");
        check(HostServices.manager().checkService(name)==null,"late completion cannot recreate retired declaration");
        worker.join();HostLooper.close(loop);
        System.out.println("PASS retired lazy service cannot publish from a late factory completion");
    }
    static void ownerExecution()throws Exception {
        Thread main=Thread.currentThread();
        var queued=new LinkedBlockingQueue<Runnable>();
        Executor executor=operation->{if(Thread.currentThread()==main)operation.run();else queued.add(operation);};
        String name="fixture.lazy.owner";var calls=new AtomicInteger();
        HostServices.registerLazy(name,IServiceManager.DESCRIPTOR,()->{
            check(Thread.currentThread()==main,"constructor uses its declared owner");calls.incrementAndGet();
            try{check(HostServices.manager().checkService(name)==null,"actual constructor reentry does not wait on itself");}
            catch(RemoteException failure){throw new AssertionError(failure);}
            return HostServices.manager();
        },true,executor);
        var lookup=new FutureTask<IBinder>(()->HostServices.manager().checkService(name));
        var worker=new Thread(lookup,"Queued lazy service lookup");worker.start();
        var posted=queued.poll(2,TimeUnit.SECONDS);check(posted!=null,"worker queued the original constructor task");
        check(!lookup.isDone(),"worker awaits its queued constructor");
        IBinder original=HostServices.manager().checkService(name);
        check(original==HostServices.manager().asBinder(),"main adopts its not-yet-run queued task");
        check(lookup.get(2,TimeUnit.SECONDS)==original,"worker receives the same published Binder");
        posted.run();check(calls.get()==1,"later queued delivery cannot run the constructor twice");
        worker.join();HostServices.unregister(name,HostServices.manager(),IServiceManager.DESCRIPTOR);
        String failed="fixture.lazy.owner-failure";var failure=new IllegalStateException("Original constructor failure");
        HostServices.registerLazy(failed,IServiceManager.DESCRIPTOR,()->{calls.incrementAndGet();throw failure;},false,executor);
        var rejected=new FutureTask<IBinder>(()->HostServices.manager().checkService(failed));
        var rejectedWorker=new Thread(rejected,"Queued failed lazy service lookup");rejectedWorker.start();
        var failedPost=queued.poll(2,TimeUnit.SECONDS);check(failedPost!=null,"worker queued the failing constructor");
        try{HostServices.manager().checkService(failed);throw new AssertionError("Constructor failure was hidden");}
        catch(IllegalStateException expected){check(expected==failure,"main retains the original constructor failure");}
        try{rejected.get(2,TimeUnit.SECONDS);throw new AssertionError("Worker did not receive constructor failure");}
        catch(ExecutionException expected){check(expected.getCause()==failure,"worker retains the same original failure");}
        failedPost.run();check(calls.get()==2,"cached failure does not retry the constructor");
        rejectedWorker.join();HostServices.unregisterLazy(failed);
        System.out.println("PASS explicit lazy owner: queued main adoption, original reentry, one Binder, unchanged inline default and cached original failure");
    }
}
