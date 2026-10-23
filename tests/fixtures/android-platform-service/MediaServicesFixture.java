package maclauncher.android.fixture;

import android.content.Context;
import android.os.Looper;
import java.nio.file.Path;
import maclauncher.android.framework.*;

/** Original profile services in an isolated test process; no game or window. */
public final class MediaServicesFixture implements AutoCloseable {
    public final Looper loop;
    public final Context context;
    private HostSystemServices system;
    private HostProcessServices processes;
    private HostProcessInfo processInfo;
    public MediaServicesFixture(Path runtime,Path data)throws Exception {
        loop=RuntimeFixture.initialize(runtime.toString(),data.toString());
        HostProcessIdentity.configure(android.os.Process.SYSTEM_UID,android.os.Process.myUid());
        try {
            processes=new HostProcessServices();
            system=HostSystemServices.start(runtime,data,"android.system");
            context=HostApplication.applicationContext();
            processInfo=new HostProcessInfo(context,processes);
        }catch(Throwable failure){try{close();}catch(Throwable cleanup){failure.addSuppressed(cleanup);}throw failure;}
    }
    @Override public void close()throws Exception {
        Exception failure=null;
        for(AutoCloseable owner:new AutoCloseable[]{processInfo,system,processes})if(owner!=null)
            try{owner.close();}catch(Exception error){if(failure==null)failure=error;else failure.addSuppressed(error);}
        processInfo=null;system=null;processes=null;
        HostApplication.shutdown();
        for(android.os.HandlerThread thread:new android.os.HandlerThread[]{
            com.android.internal.os.BackgroundThread.get(),com.android.server.FgThread.get(),com.android.server.IoThread.get()}){
            thread.quitSafely();thread.join(2000);
            if(thread.isAlive()&&failure==null)failure=new IllegalStateException("Media fixture service thread did not retire: "+thread.getName());
        }
        HostLooper.close(loop);FrameworkResources.shutdown();
        if(failure!=null)throw failure;
    }
}
