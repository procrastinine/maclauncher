import android.app.AppOpsManager;
import android.content.Context;
import android.os.*;
import com.android.internal.app.IAppOpsService;
import java.lang.reflect.*;
import java.nio.file.Path;
import java.util.*;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.fixture.PackageManifest;
import maclauncher.android.framework.*;

/** Original client/Binder types; token notification is controlled by the fixture. */
public final class HostAppOpsClientDeathProbe {
    static final int OP=AppOpsManager.OP_PLAY_AUDIO;
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static final class Client implements InvocationHandler {
        final Binder binder=new Binder();
        final Set<IBinder.DeathRecipient> links=new HashSet<>();
        final IBinder token=(IBinder)Proxy.newProxyInstance(IBinder.class.getClassLoader(),new Class<?>[]{IBinder.class},this);
        IBinder.DeathRecipient last;int registered,unlinked;boolean dead;
        public Object invoke(Object proxy,Method method,Object[] args)throws Throwable {
            switch(method.getName()){
                case "linkToDeath":if(dead)throw new DeadObjectException();last=(IBinder.DeathRecipient)args[0];links.add(last);registered++;return null;
                case "unlinkToDeath":if(links.remove((IBinder.DeathRecipient)args[0])){unlinked++;return true;}return false;
                default:try{return method.invoke(binder,args);}catch(InvocationTargetException failure){throw failure.getCause();}
            }
        }
        void die(){dead=true;var callbacks=List.copyOf(links);links.clear();callbacks.forEach(IBinder.DeathRecipient::binderDied);}
    }
    static void start(IAppOpsService service,Client client,int uid,String pkg,String tag)throws Exception {
        check(service.startOperation(client.token,OP,uid,pkg,tag,false,false,null,false,0,0).getOpMode()==AppOpsManager.MODE_ALLOWED,"native client start is allowed");
    }
    public static void main(String[] args){
        Looper loop=null;
        try{
            loop=RuntimeFixture.initialize(args[0],args[1]);
            HostProcessIdentity.configure(10041,android.os.Process.myUid());
            Path runtime=Path.of(args[0]),data=Path.of(args[1]),apk=data.resolve("fixture.apk");
            PackageManifest.add(apk,"window");FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
            HostContext.hostPackage("org.example.window","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
            HostContext.hostClassLoader(HostAppOpsClientDeathProbe.class.getClassLoader());HostPackages.inspectSources(List.of(apk));
            System.load(System.getProperty("klepton.graphics"));HostDisplay.initializeHeadless();HostStorageService.install();
            Context context=HostApplication.applicationContext();
            HostAppOps.install(context);
            IAppOpsService service=IAppOpsService.Stub.asInterface(ServiceManager.getService(Context.APP_OPS_SERVICE));
            int uid=android.os.Process.myUid();String pkg=context.getPackageName();
            try{service.setUidMode(OP,uid,AppOpsManager.MODE_IGNORED);throw new AssertionError("unprivileged app changed UID mode");}catch(SecurityException expected){}
            Client first=new Client(),second=new Client();
            start(service,first,uid,pkg,null);start(service,first,uid,pkg,null);
            check(first.registered==1,"nested starts share their existing attributed owner/death link");
            service.finishOperation(first.token,OP,uid,pkg,null);
            check(first.unlinked==0&&service.isOperationActive(OP,uid,pkg),"one finish retains nested operation");
            start(service,second,uid,pkg,null);first.die();
            check(service.isOperationActive(OP,uid,pkg),"another client's active operation survives death");
            service.finishOperation(second.token,OP,uid,pkg,null);
            check(second.unlinked==1&&!service.isOperationActive(OP,uid,pkg),"last finish unlinks and dead client's count is gone");
            try{start(service,first,uid,pkg,null);throw new AssertionError("dead Binder accepted");}catch(RuntimeException expected){check(expected.getCause() instanceof DeadObjectException,"original dead-client failure preserved");}
            Client replaced=new Client();start(service,replaced,uid,pkg,"a");IBinder.DeathRecipient old=replaced.last;
            service.finishOperation(replaced.token,OP,uid,pkg,"a");start(service,replaced,uid,pkg,"a");old.binderDied();
            check(service.isOperationActive(OP,uid,pkg),"late retired death cannot remove replacement attributed owner");
            start(service,replaced,uid,pkg,"b");replaced.die();
            check(!service.isOperationActive(OP,uid,pkg),"death retires every attribution and nested count for that token");
            Client denied=new Client();check(service.startOperation(denied.token,OP,uid+1,pkg,null,false,false,null,false,0,0).getOpMode()==AppOpsManager.MODE_ERRORED&&denied.registered==0,"UID boundary unchanged");
            check(service.startOperation(denied.token,OP,uid,pkg+".other",null,false,false,null,false,0,0).getOpMode()==AppOpsManager.MODE_ERRORED&&denied.registered==0,"package boundary unchanged");
            Client retiring=new Client();start(service,retiring,uid,pkg,null);HostLooper.close(loop);loop=null;
            check(retiring.unlinked==1&&retiring.links.isEmpty(),"application retirement releases live Binder death subscription");
            System.out.println("PASS shared AppOps client death, nested counts, token isolation and retirement");System.exit(0);
        }catch(Throwable failure){failure.printStackTrace();if(loop!=null)try{HostLooper.close(loop);}catch(Throwable cleanup){failure.addSuppressed(cleanup);}System.exit(1);}
    }
}
