package maclauncher.android.fixture;

import android.os.DeadObjectException;
import maclauncher.android.framework.*;
import java.util.*;
import java.util.concurrent.*;

/** Window startup reserves the ordinary directory without waiting for it. */
public final class WindowServiceStartupProbe {
    public static void main(String[] args)throws Exception {
        List<HostProcessServices.Key> requests=new ArrayList<>();
        HostRemoteServices.resolver((key,id)->requests.add(key));
        HostRemoteServices.prepareWindowServices();
        if(!requests.isEmpty())throw new AssertionError("An undeclared process was requested");
        var owner=new HostProcessServices.Key("android","android.system");
        HostRemoteServices.platformOwner(owner);
        if(!requests.isEmpty())throw new AssertionError("A declaration started its process");
        HostRemoteServices.prepareWindowServices();
        HostRemoteServices.prepareWindowServices();
        if(!requests.equals(List.of(owner)))throw new AssertionError("Window startup did not coalesce its pending directory");
        // The original consumer uses the reservation rather than another
        // activation. Authority retirement must release that same future.
        var field=HostRemoteServices.class.getDeclaredField("processes");field.setAccessible(true);
        var directory=(HostProcessServices)field.get(null);
        var pending=directory.find(owner.packageName(),owner.processName());
        var waiting=CompletableFuture.supplyAsync(()->{
            try{pending.service("activity");throw new AssertionError("An unpublished service was returned");}
            catch(DeadObjectException expected){return true;}
            catch(android.os.RemoteException failure){throw new CompletionException(failure);}
        });
        if(requests.size()!=1)throw new AssertionError("The consumer duplicated the startup request");
        HostRemoteServices.authorityClosed();
        if(!waiting.get(5,TimeUnit.SECONDS))throw new AssertionError("Pending directory was not retired");
        HostRemoteServices.prepareWindowServices();
        if(requests.size()!=1)throw new AssertionError("Retired authority was revived");
        System.out.println("PASS window Settings startup overlaps application setup with one authenticated directory and ordinary retirement");
    }
}
