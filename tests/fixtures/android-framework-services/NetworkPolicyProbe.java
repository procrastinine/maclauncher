package maclauncher.android.framework;

import android.net.ConnectivityManager;
import android.net.IConnectivityManager;
import java.util.*;
import java.util.concurrent.*;

/** Offline original-client/service boundary; no host sockets or route changes. */
public final class NetworkPolicyProbe {
    private static void check(boolean value,String detail){if(!value)throw new AssertionError(detail);}
    private static HostBinderRpc.Peer peer(int pid,int uid){return new HostBinderRpc.Peer("example.app"+uid,"example.app"+uid+":"+pid,pid,50000+pid,uid);}
    private static final class Service extends IConnectivityManager.Default {
        final HostProcessServices owner;
        final Map<Integer,Integer> rules=new ConcurrentHashMap<>();
        final List<String> calls=Collections.synchronizedList(new ArrayList<>());
        volatile CountDownLatch entered,release;
        volatile int heldUid=-1;
        boolean enabled;
        Service(HostProcessServices owner){this.owner=owner;}
        @Override public void setFirewallChainEnabled(int chain,boolean value){
            check(chain==ConnectivityManager.FIREWALL_CHAIN_OEM_DENY_1,"one original dedicated chain");
            check(!Thread.holdsLock(owner),"no owner lock across original Binder client");
            enabled=value;calls.add("chain:"+value);
        }
        @Override public void setUidFirewallRule(int chain,int uid,int rule){
            check(enabled,"chain enabled before UID dispatch");
            check(chain==ConnectivityManager.FIREWALL_CHAIN_OEM_DENY_1,"same policy/packet chain");
            check(!Thread.holdsLock(owner),"reentrant policy call holds no process lock");
            check(android.os.UserHandle.getAppId(uid)>=10000,"core UIDs are not rewritten");
            owner.networkBlocked(uid); // A service can query this same owner.
            if(uid==heldUid&&rule==ConnectivityManager.FIREWALL_RULE_DENY){
                heldUid=-1;entered.countDown();
                try{check(release.await(5,TimeUnit.SECONDS),"policy release");}
                catch(InterruptedException failure){Thread.currentThread().interrupt();throw new AssertionError(failure);}
            }
            rules.put(uid,rule);calls.add(uid+":"+rule);
        }
        boolean blocked(int uid){return enabled&&rules.getOrDefault(uid,0)==ConnectivityManager.FIREWALL_RULE_DENY;}
    }
    private static AutoCloseable attach(HostProcessServices owner,Service service)throws Exception {
        var method=HostNetworkingServices.class.getDeclaredMethod("uidPolicy",IConnectivityManager.class,HostProcessServices.class);
        method.setAccessible(true);return (AutoCloseable)method.invoke(null,service,owner);
    }
    public static void main(String[] args)throws Exception {
        var owner=new HostProcessServices();var service=new Service(owner);
        HostBinderRpc.Peer offline=peer(101,10001),online=peer(102,10002),sameUid=peer(103,10001),deniedAgain=peer(104,10001);
        owner.expectNetwork(offline,false);owner.expectNetwork(online,true);
        check(service.calls.isEmpty(),"early activation is retained without inventing a service");
        var projection=attach(owner,service);
        check(service.blocked(10001)&&!service.blocked(10002),"initial snapshot precedes system readiness");
        owner.expectNetwork(peer(105,1000),false);owner.expectNetwork(peer(106,101000),false);
        owner.expectIncoming(peer(107,10002));check(!service.blocked(10002),"incoming Binder caller cannot create a deny grant");
        owner.expectNetwork(sameUid,true);owner.expectNetwork(deniedAgain,false);
        check(service.blocked(10001),"UID policy is the live grant intersection");
        try{owner.expectNetwork(offline,true);throw new AssertionError("activation policy changed");}catch(SecurityException expected){}
        owner.unavailable(offline);check(service.blocked(10001),"one denial retiring cannot erase another");
        owner.unavailable(deniedAgain);check(!service.blocked(10001),"last denial retirement restores online UID");
        check(!service.blocked(10002),"independent online sibling is untouched");

        var blocked=peer(108,10003);service.heldUid=10003;service.entered=new CountDownLatch(1);service.release=new CountDownLatch(1);
        var threads=Executors.newFixedThreadPool(3);
        try{
            var enrollment=threads.submit(()->owner.expectNetwork(blocked,false));
            check(service.entered.await(5,TimeUnit.SECONDS),"entered original policy service");
            check(!enrollment.isDone(),"enrollment cannot acknowledge before rule application");
            var retiring=threads.submit(()->owner.unavailable(blocked));
            // Wait for the existing activation to retire, without polling the
            // host or using a second test-only policy registry.
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            while(owner.networkBlocked(10003)&&System.nanoTime()<until)Thread.onSpinWait();
            check(!owner.networkBlocked(10003),"retirement removes canonical activation");
            var detaching=threads.submit(()->{try{projection.close();}catch(Exception failure){throw new CompletionException(failure);}});
            service.release.countDown();
            enrollment.get(5,TimeUnit.SECONDS);retiring.get(5,TimeUnit.SECONDS);detaching.get(5,TimeUnit.SECONDS);
            check(!service.enabled&&!service.blocked(10003),"teardown drains previous writes before disabling chain");
            check(service.rules.get(10003)==ConnectivityManager.FIREWALL_RULE_DEFAULT,"retired UID rule is cleared before detach");
            int count=service.calls.size();owner.close();check(service.calls.size()==count,"retired projection cannot receive late callbacks");
        }finally{service.release.countDown();threads.shutdownNow();owner.close();}
        System.out.println("PASS original connectivity client policy, UID intersection and ordered retirement");
    }
}
