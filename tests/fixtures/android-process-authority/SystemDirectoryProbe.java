package maclauncher.android;

import android.app.Application;
import android.content.Context;
import android.os.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;
import org.json.*;

/** Real listener sessions retain app UIDs and reverse directories across JVMs. */
public final class SystemDirectoryProbe {
    static HostBinderRpc.Peer peer(JSONObject value)throws Exception{return new HostBinderRpc.Peer(value.getString("packageName"),value.getString("processName"),value.getInt("pid"),value.getInt("uid"));}
    public static void main(String[] args)throws Exception {
        RuntimeFixture.initialize(args[0],args[1],Path.of(args[0],"native/libklepton-graphics.dylib").toString());
        int uid=Integer.parseInt(args[3]);HostProcessIdentity.configure(uid,Integer.parseInt(args[4]));HostStorageService.install();
        Path apk=Path.of(args[1],"fixture.apk");SyntheticResources.apk(apk,"","Service",null);
        FrameworkResources.configure(Path.of(args[0],"android-framework.jar"),List.of(apk));
        HostContext.hostApplicationIdentity(uid,0);HostDisplay.hostPublish(1,320,240,60);HostApplication.prepare(SystemDirectoryProbe.class.getClassLoader());
        Context context=HostApplication.applicationContext();Application application=new Application();HostApplication.attach(application,context);HostApplication.create(application);
        var field=HostRemoteServices.class.getDeclaredField("processes");field.setAccessible(true);var processes=(HostProcessServices)field.get(null);
        String role=args[2];
        HostServices.register("fixture.identity",new IUserManager.Default(){@Override public String getUserName(){
            int caller=Binder.getCallingUid();
            if(role.equals("server"))try{
                var peer=HostBinderRpc.callingPeer();if(peer==null||peer.uid()!=caller)throw new AssertionError("Caller identity was relayed");
                var reverse=processes.find(peer);
                if(reverse==null)throw new AssertionError("Authenticated caller directory missing");
                String response=IUserManager.Stub.asInterface(reverse.service("fixture.identity")).getUserName();
                if(!response.equals(uid+":"+caller))throw new AssertionError(response);
            }catch(RemoteException failure){throw new IllegalStateException(failure);}
            return caller+":"+uid;
        }},"android.os.IUserManager");
        var input=new BufferedReader(new InputStreamReader(System.in));
        if(role.equals("server"))try(var listener=HostRemoteServices.listenProcess(args[5],context)) {
            System.out.println("READY");System.out.flush();
            for(String line;(line=input.readLine())!=null;){var request=new JSONObject(line);var peer=peer(request);HostRemoteServices.expect(peer);System.out.println("ENROLLED "+peer.pid());System.out.flush();}
        }else{
            System.out.println("READY");System.out.flush();var server=peer(new JSONObject(input.readLine()));
            HostRemoteServices.expect(server);HostServiceDirectory.connect(args[5],server,context,4);
            String response=IUserManager.Stub.asInterface(processes.find(server).service("fixture.identity")).getUserName();
            if(!response.equals(uid+":"+server.uid()))throw new AssertionError(response);
            System.out.println("PASS "+uid);System.out.flush();
            input.readLine();
        }
        HostRemoteServices.shutdown();HostApplication.shutdown();HostWindowManager.shutdown();HostDisplay.hostShutdown();HostDisplay.hostRemove();FrameworkResources.shutdown();HostLooper.close(Looper.getMainLooper());HostContext.hostShutdown();System.exit(0);
    }
}
