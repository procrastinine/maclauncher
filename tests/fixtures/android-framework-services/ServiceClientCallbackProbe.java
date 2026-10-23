import android.os.*;
import java.util.*;
import maclauncher.android.framework.HostServices;
import maclauncher.android.fixture.RuntimeFixture;

public final class ServiceClientCallbackProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static final class Callback extends IClientCallback.Stub {
        final Set<IBinder.DeathRecipient> deaths=new HashSet<>();
        int events;
        public void onClients(IBinder service,boolean clients){events++;}
        @Override public void linkToDeath(IBinder.DeathRecipient death,int flags){deaths.add(death);}
        @Override public boolean unlinkToDeath(IBinder.DeathRecipient death,int flags){return deaths.remove(death);}
        void die(){var pending=List.copyOf(deaths);deaths.clear();for(var death:pending)death.binderDied();}
    }
    public static void main(String[] args)throws Exception {
        RuntimeFixture.initialize(args[0],args[1]);
        IServiceManager directory=HostServices.manager();
        Binder service=new Binder();String name="test.client-lifecycle";
        directory.addService(name,service,false,0);
        Callback callback=new Callback();
        directory.registerClientCallback(name,service,callback);
        directory.registerClientCallback(name,service,callback);
        check(callback.deaths.size()==1,"Repeated registration retains one death owner");
        check(callback.events==0,"Unavailable kernel node counts do not fabricate client transitions");
        callback.die();
        directory.registerClientCallback(name,service,callback);
        check(callback.deaths.size()==1,"Dead callback registration was retired");
        directory.tryUnregisterService(name,service);
        check(callback.deaths.isEmpty(),"Service removal releases callback death links");
        check(directory.checkService(name)==null,"Service removed");
        System.out.println("PASS original service callback fallback and callback ownership");
    }
}
