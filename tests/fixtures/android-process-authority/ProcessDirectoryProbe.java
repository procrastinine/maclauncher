package maclauncher.android;

import android.app.Application;
import android.content.Context;
import android.os.*;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;
import org.json.*;

/** Separate JVMs publish original AIDL directories in both directions on one demanded session. */
public final class ProcessDirectoryProbe {
    private static void activationOwnership(){
        var incoming=new HostBinderRpc.Peer("fixture.shared","fixture.shared",90,10001);
        var provider=new HostBinderRpc.Peer("fixture.shared","fixture.shared",91,10001);
        var scoped=new HostProcessServices();List<String> requests=new ArrayList<>();scoped.resolver((key,id)->requests.add(id));
        scoped.expectIncoming(incoming);
        if(!incoming.equals(scoped.expectedIdentity(incoming.pid())))throw new AssertionError("Incoming caller lost authentication");
        if(scoped.find(incoming)!=null)throw new AssertionError("Incoming authentication became a published directory");
        var demanded=scoped.find(incoming.packageName(),incoming.processName());
        if(requests.size()!=1)throw new AssertionError("Incoming caller suppressed provider demand");
        scoped.expectIncoming(new HostBinderRpc.Peer("fixture.shared","fixture.shared",92,10001));
        if(scoped.find(incoming.packageName(),incoming.processName())!=demanded)throw new AssertionError("Incoming caller adopted a provider request");
        scoped.expect(provider,"provider");
        if(scoped.find(provider)!=demanded)throw new AssertionError("Published provider did not adopt its request");
        scoped.unavailable(incoming);
        if(scoped.find(provider)!=demanded)throw new AssertionError("Incoming caller retirement removed provider");
        scoped.close();
        var owner=new HostProcessServices();owner.resolver(key->{});
        var oldPeer=new HostBinderRpc.Peer("fixture.owner","fixture.owner",100,10001);
        var newPeer=new HostBinderRpc.Peer("fixture.owner","fixture.owner",101,10001);
        var pending=owner.find(oldPeer.packageName(),oldPeer.processName());owner.unavailable(oldPeer);
        if(owner.find(oldPeer.packageName(),oldPeer.processName())!=pending)throw new AssertionError("Old death retired an unbound replacement request");
        owner.expect(oldPeer);owner.expect(newPeer);var replacement=owner.find(newPeer.packageName(),newPeer.processName());
        if(replacement==pending)throw new AssertionError("New process did not replace old identity");
        owner.unavailable(oldPeer);if(owner.find(newPeer.packageName(),newPeer.processName())!=replacement)throw new AssertionError("Old death retired a replacement process");
        owner.close();
        owner=new HostProcessServices();List<String> demands=new ArrayList<>();owner.resolver((key,id)->demands.add(id));
        var key=new HostProcessServices.Key(oldPeer.packageName(),oldPeer.processName());
        var first=owner.find(key.packageName(),key.processName());owner.unavailable(key,demands.get(0));
        var retry=owner.find(key.packageName(),key.processName());if(first==retry)throw new AssertionError("Failed demand was retained");
        owner.unavailable(key,demands.get(0));if(owner.find(key.packageName(),key.processName())!=retry)throw new AssertionError("Old request failure retired its replacement");
        owner.expect(oldPeer,"first");owner.unavailable(key,demands.get(1));
        if(owner.find(oldPeer)!=retry)throw new AssertionError("Late demand failure retired an adopted session");
        owner.expect(oldPeer,"second");var next=owner.find(oldPeer);if(next==retry)throw new AssertionError("Reconnect reused an earlier session owner");
        owner.unavailable(oldPeer,"first");if(owner.find(oldPeer)!=next)throw new AssertionError("Old session death retired its replacement");
        owner.close();
    }
    public static void main(String[] args)throws Exception{
        RuntimeFixture.initialize(args[0],args[1],Path.of(args[0],"native/libklepton-graphics.dylib").toString());activationOwnership();HostStorageService.install();
        Path apk=Path.of(args[1],"fixture.apk");SyntheticResources.apk(apk,"","Service",null);FrameworkResources.configure(Path.of(args[0],"android-framework.jar"),List.of(apk));
        HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostDisplay.hostPublish(1,320,240,60);HostApplication.prepare(ProcessDirectoryProbe.class.getClassLoader());Context context=HostApplication.applicationContext();
        Application application=new Application();HostApplication.attach(application,context);HostApplication.create(application);
        Field directory=HostRemoteServices.class.getDeclaredField("processes");directory.setAccessible(true);HostProcessServices processes=(HostProcessServices)directory.get(null);
        var constructor=LaunchConfig.class.getDeclaredConstructor(Map.class);constructor.setAccessible(true);
        String role=args[2],packageName=role.equals("game")?"example.game":"example.service";
        String processName=role.equals("game")?packageName:"example.service:"+(role.equals("service")?"needed":"second");
        LaunchConfig config=constructor.newInstance(Map.of("authorityFd",5L,"packageName",packageName,"processName",processName,"serviceProcess",1L));
        var disconnected=new java.util.concurrent.CountDownLatch(1);
        try(var authority=ProcessAuthority.read(config)){
            HostServices.register("fixture.name",new IUserManager.Default(){@Override public String getUserName(){
                try{if(role.equals("service")){
                    var nested=processes.find("example.service","example.service:second");
                    String name=IUserManager.Stub.asInterface(nested.service("fixture.name")).getUserName();
                    if(!name.equals("second"))throw new AssertionError(name);
                    var reverse=processes.find("example.game","example.game");
                    name=IUserManager.Stub.asInterface(reverse.service("fixture.name")).getUserName();
                    if(!name.equals("game"))throw new AssertionError(name);
                    System.out.println("{\"reverse\":true}");
                }return role;}catch(RemoteException failure){throw new IllegalStateException(failure);}
            }},"android.os.IUserManager");
            authority.monitor(context,disconnected::countDown);
            if(role.equals("game")){
                var remote=processes.find("example.service","example.service:needed");
                String name=IUserManager.Stub.asInterface(remote.service("fixture.name")).getUserName();
                if(!name.equals("service"))throw new AssertionError(name);
                System.out.println("{\"echo\":true}");
                remote.close();
                var replacement=processes.find("example.service","example.service:needed");
                if(replacement==remote)throw new AssertionError("Retired connection was reused");
                name=IUserManager.Stub.asInterface(replacement.service("fixture.name")).getUserName();
                if(!name.equals("service"))throw new AssertionError(name);
                System.out.println("{\"reconnected\":true}");
            }
            disconnected.await();
        }finally{HostRemoteServices.shutdown();HostApplication.shutdown();HostWindowManager.shutdown();HostDisplay.hostShutdown();HostDisplay.hostRemove();FrameworkResources.shutdown();HostLooper.close(Looper.getMainLooper());HostContext.hostShutdown();}
        System.exit(0);
    }
}
