import android.app.AppOpsManager;
import android.content.Context;
import android.os.*;
import com.android.internal.app.*;
import com.android.server.appop.AppOpsService;
import java.nio.file.Path;
import maclauncher.android.fixture.MediaServicesFixture;
import maclauncher.android.framework.HostLooper;

/** Original service/client mode, operation and callback ownership. */
public final class AppOpsServiceProbe {
    static void check(boolean value,String name){if(!value)throw new AssertionError(name);}
    static void drainUntil(Looper loop,java.util.function.BooleanSupplier complete)throws Exception{
        long end=System.nanoTime()+2_000_000_000L;
        while(!complete.getAsBoolean()&&System.nanoTime()<end){HostLooper.drain(loop);Thread.sleep(2);}
        check(complete.getAsBoolean(),"original app-op callback delivery");
    }
    public static void main(String[] args)throws Exception {
        try(var services=new MediaServicesFixture(Path.of(args[0]),Path.of(args[1]))){
            Context context=services.context;Looper loop=services.loop;
            AppOpsManager client=context.getSystemService(AppOpsManager.class);
            int uid=android.os.Process.myUid();String own=context.getPackageName();
            IAppOpsService service=IAppOpsService.Stub.asInterface(ServiceManager.getService(Context.APP_OPS_SERVICE));
            check(service instanceof AppOpsService,"complete original service owns Binder API");
            int original=client.unsafeCheckOpRawNoThrow(AppOpsManager.OPSTR_PLAY_AUDIO,uid,own);
            int[] changes={0};IAppOpsCallback callback=new IAppOpsCallback.Stub(){public void opChanged(int op,int changedUid,String changedPackage,String device){changes[0]++;}};
            service.startWatchingMode(AppOpsManager.OP_PLAY_AUDIO,own,callback);
            try {
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_IGNORED);
                drainUntil(loop,()->changes[0]>0);
                check(client.checkOpNoThrow(AppOpsManager.OP_PLAY_AUDIO,uid,own)==AppOpsManager.MODE_IGNORED,"original mode changes reach client");
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_ALLOWED);
                IBinder token=new Binder();
                check(service.startOperation(token,AppOpsManager.OP_PLAY_AUDIO,uid,own,null,false,false,null,false,0,0).getOpMode()==AppOpsManager.MODE_ALLOWED,"original noted result");
                check(service.isOperationActive(AppOpsManager.OP_PLAY_AUDIO,uid,own),"original active operation");
                service.finishOperation(token,AppOpsManager.OP_PLAY_AUDIO,uid,own,null);
                check(!service.isOperationActive(AppOpsManager.OP_PLAY_AUDIO,uid,own),"original operation retires");
                HostLooper.drain(loop);service.stopWatchingMode(callback);
                int before=changes[0];service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_IGNORED);
                for(int i=0;i<20;i++){HostLooper.drain(loop);Thread.sleep(2);}
                check(changes[0]==before,"callback retirement");
            }finally{service.stopWatchingMode(callback);service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,original);}
        }
        System.out.println("PASS raw AppOps client, original modes, active operations and callback retirement");
        System.exit(0);
    }
}
