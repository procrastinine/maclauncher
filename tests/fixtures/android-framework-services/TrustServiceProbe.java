package maclauncher.android.fixture;

import android.app.Application;
import android.app.KeyguardManager;
import android.app.trust.*;
import android.content.Context;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;

public final class TrustServiceProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    interface Operation {void run()throws Exception;}
    static void denied(Operation operation)throws Exception{try{operation.run();throw new AssertionError("Expected original permission denial");}catch(SecurityException expected){}}
    static final class Listener extends ITrustListener.Stub {
        final Set<IBinder.DeathRecipient> deaths=new HashSet<>();int state,agents;
        @Override public void linkToDeath(IBinder.DeathRecipient death,int flags){deaths.add(death);}
        @Override public boolean unlinkToDeath(IBinder.DeathRecipient death,int flags){return deaths.remove(death);}
        void die(){var callbacks=List.copyOf(deaths);deaths.clear();for(var death:callbacks)death.binderDied();}
        public void onEnabledTrustAgentsChanged(int user){check(user==0,"profile user");agents++;}
        public void onTrustChanged(boolean enabled,boolean unlocked,int user,int flags,List<String> messages){check(!enabled&&!unlocked&&user==0&&flags==0&&messages.isEmpty(),"no fabricated trust grant");state++;}
        public void onTrustManagedChanged(boolean managed,int user){check(!managed&&user==0,"no trust agents");state++;}
        public void onTrustError(CharSequence message){throw new AssertionError(message);}
        public void onIsActiveUnlockRunningChanged(boolean active,int user){check(!active&&user==0,"no active authentication");state++;}
    }
    public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
    static void run(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Path.of(args[1]);Looper loop=RuntimeFixture.initialize(args[0],args[1]);
        HostProcessIdentity.configure(android.os.Process.SYSTEM_UID,android.system.Os.getuid());
        Path framework=runtime.resolve("android-framework.jar");FrameworkResources.configure(framework,List.of(framework));
        HostContext.hostPackage("android","16",1);HostContext.hostApplicationInfo(0,framework.toString(),data.toString(),runtime.resolve("native").toString(),0);HostContext.hostApplicationIdentity(android.os.Process.SYSTEM_UID,0);
        HostPackages.inspectSources(List.of(framework));HostStorageService.install();HostApplication.prepare(TrustServiceProbe.class.getClassLoader());
        var context=HostApplication.applicationContext();HostApplication.attach(new Application(),context);
        Listener listener=new Listener();
        try(var owner=new HostTrustService(context)){
            for(var method:ITrustManager.class.getDeclaredMethods())check(HostTrustService.class.getMethod(method.getName(),method.getParameterTypes()).getDeclaringClass()==HostTrustService.class,"complete original contract: "+method);
            var service=ITrustManager.Stub.asInterface(ServiceManager.getService(Context.TRUST_SERVICE));
            var keyguard=context.getSystemService(KeyguardManager.class);
            check(keyguard!=null&&!keyguard.isDeviceLocked()&&!keyguard.isDeviceSecure(),"original KeyguardManager sees an unsecured device");
            check(!keyguard.isKeyguardLocked()&&!keyguard.isKeyguardSecure(),"original window keyguard agrees");
            service.registerTrustListener(listener);HostLooper.drain(loop);
            check(listener.state==3&&listener.deaths.size()==1,"initial original listener state and one death owner");
            service.registerTrustListener(listener);HostLooper.drain(loop);check(listener.state==3,"duplicate listener is idempotent");
            service.setDeviceLockedForUser(0,true);check(!service.isDeviceLocked(0,0),"unsecured profile cannot acquire a fake credential lock");
            service.reportEnabledTrustAgentsChanged(0);HostLooper.drain(loop);check(listener.agents==1,"original agents-change notification");
            listener.die();service.reportEnabledTrustAgentsChanged(0);HostLooper.drain(loop);check(listener.agents==1,"dead listener retired");
            service.registerTrustListener(listener);HostLooper.drain(loop);
            service.unregisterTrustListener(listener);HostLooper.drain(loop);check(listener.deaths.isEmpty(),"unregister releases death owner");
            var pair=ParcelFileDescriptor.createSocketPair();
            var app=new HostBinderRpc.Peer("fixture.trust.app","fixture.trust.app",android.os.Process.myPid(),20001);
            var system=new HostBinderRpc.Peer("android","android",android.os.Process.myPid(),1000);
            try(var server=HostBinderRpc.serve(pair[0],app,owner.asBinder(),2);var client=HostBinderRpc.connect(pair[1],system,2)){
                var remote=ITrustManager.Stub.asInterface(client.root());
                check(!remote.isDeviceLocked(0,0)&&!remote.isDeviceSecure(0,0),"authenticated ordinary original client reads its own unsecured user");
                denied(()->remote.isDeviceLocked(10,0));
                denied(()->remote.reportUnlockAttempt(true,0));
                denied(()->remote.setDeviceLockedForUser(0,true));
                denied(()->remote.registerTrustListener(listener));
                denied(()->remote.isTrustUsuallyManaged(0));
                denied(remote::isInSignificantPlace);
            }finally{pair[0].close();pair[1].close();}
            service.registerTrustListener(listener);HostLooper.drain(loop);check(listener.deaths.size()==1,"listener restored for shutdown");
        }finally{HostApplication.shutdown();HostLooper.close(loop);FrameworkResources.shutdown();}
        check(listener.deaths.isEmpty(),"service shutdown releases listener");
        check(HostServices.manager().checkService(Context.TRUST_SERVICE)==null,"published service retired");
        System.out.println("PASS original KeyguardManager and complete Trust AIDL: unsecured state, authenticated permissions, callbacks, death and retirement");
    }
}
