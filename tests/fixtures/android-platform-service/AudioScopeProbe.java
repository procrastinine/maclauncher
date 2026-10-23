package maclauncher.android;

import android.content.*;
import android.media.IAudioPolicyService;
import android.os.*;
import com.android.media.permission.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import maclauncher.android.framework.*;

/** Actual original Binder RPC clients, each owning one native-policy endpoint. */
public final class AudioScopeProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable error){error.printStackTrace();System.exit(1);}}
    private static void run(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Files.createDirectories(Path.of(args[1]));int uid=Integer.parseInt(args[4]);
        RuntimeBootstrap.initialize(runtime,data,Files.createDirectories(data.resolve("files")),Files.createDirectories(data.resolve("cache")),uid==1000?"android":"fixture.client",false,false,false);
        HostProcessIdentity.configure(uid,(int)new com.sun.security.auth.module.UnixSystem().getUid());
        Looper loop=HostLooper.main();var input=new BufferedReader(new InputStreamReader(System.in));
        System.out.println("READY");System.out.flush();check("connect".equals(input.readLine()),"Supervisor enrollment precedes connection");
        var peer=new HostBinderRpc.Peer("android","android.system",Integer.parseInt(args[3]),1000,"u:r:system_server:s0");
        AtomicInteger populations=new AtomicInteger(),permissions=new AtomicInteger();
        var controller=new INativePermissionController.Stub(){
            public void populatePackagesForUids(List<UidPackageState> values){check(values.stream().anyMatch(value->value.uid==1000),"Original system package catalog");populations.incrementAndGet();}
            public void updatePackagesForUid(UidPackageState value){}
            public void populatePermissionState(byte permission,int[] uids){permissions.incrementAndGet();}
        };
        var policy=new IAudioPolicyService.Default(){@Override public INativePermissionController getPermissionController(){return controller;}};
        // No permissions are bypassed: this endpoint only answers the original
        // permission-controller getter. Any unexpected context use fails.
        Context context=new ContextWrapper(null){@Override public Object getSystemService(String name){if(name.equals(Context.PERMISSION_ENFORCER_SERVICE))return new PermissionEnforcer(this);throw new AssertionError(name);}};
        IBinder endpoint=HostServiceEndpoints.export(policy,IAudioPolicyService.DESCRIPTOR,context);
        try(var connection=HostBinderRpc.connect(args[2],peer,4)){
            IServiceManager directory=IServiceManager.Stub.asInterface(connection.root());
            check(directory.checkService("package_native")!=null,"Canonical shared services remain visible");
            System.out.println("OK");System.out.flush();String line;
            while((line=input.readLine())!=null){
                switch(line){
                    case "publish"->{
                        int before=populations.get();directory.addService("media.audio_policy",endpoint,false,0);
                        long until=System.nanoTime()+5_000_000_000L;while((populations.get()==before||permissions.get()==0)&&System.nanoTime()<until)Thread.sleep(10);
                        check(populations.get()>before&&permissions.get()>0,"One original provider populates packages and grants");
                    }
                    case "check"->{
                        var found=IAudioPolicyService.Stub.asInterface(directory.checkService("media.audio_policy"));
                        check(found!=null&&found.getPermissionController().asBinder()==controller.asBinder(),"Native service resolves to its authenticated composition");
                        check(Arrays.stream(directory.getServiceDebugInfo()).anyMatch(value->value.name.equals("media.audio_policy")&&value.debugPid==ProcessHandle.current().pid()),"Original service metadata retains the physical owner PID");
                    }
                    case "unregister"->{directory.tryUnregisterService("media.audio_policy",endpoint);check(directory.checkService("media.audio_policy")==null,"No other composition leaks through lookup");}
                    case "denied"->{try{directory.addService("media.audio_policy",endpoint,false,0);throw new AssertionError("Unprivileged service registration accepted");}catch(SecurityException expected){}}
                    case "snapshot"->{System.out.println("COUNTS "+populations.get()+" "+permissions.get());System.out.flush();continue;}
                    case "stop"->{System.out.println("OK");System.out.flush();return;}
                    default->throw new AssertionError(line);
                }
                System.out.println("OK");System.out.flush();
            }
        }finally{HostLooper.close(loop);}
    }
}
