package maclauncher.android;

import android.os.*;
import java.io.*;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;
import org.json.JSONObject;

/** Original authority framing and Binder lookup before application-context creation. */
public final class ProfileServiceDemandProbe {
    private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    private static JSONObject identity(String packageName,String processName,int uid,String securityContext,int hostUid)throws Exception{
        return new JSONObject().put("packageName",packageName).put("processName",processName)
            .put("pid",android.system.Os.getpid()).put("hostPid",HostProcessIdentity.physicalPid())
            .put("uid",uid).put("hostUid",hostUid).put("securityContext",securityContext);
    }
    private static HostBinderRpc.Peer peer(JSONObject value)throws Exception{
        return new HostBinderRpc.Peer(value.getString("packageName"),value.getString("processName"),value.getInt("pid"),value.getInt("uid"),value.getString("securityContext"));
    }
    private static void owner(String socket,int hostUid)throws Exception{
        HostProcessIdentity.configure(1000,hostUid);
        var processes=new HostProcessServices();
        HostServices.manager().addService("processinfo",new IProcessInfoService.Stub(){
            @Override public void getProcessStatesFromPids(int[] pids,int[] states){
                var caller=HostBinderRpc.callingPeer();
                check(caller!=null&&caller.equals(processes.expectedIdentity(caller.pid())),"Native directory caller was not authenticated");
                check(caller.uid()==10023&&Binder.getCallingUid()==10023,"Original Binder caller identity changed");
                for(int index=0;index<pids.length;index++)states[index]=40+pids[index];
            }
            @Override public void getProcessStatesAndOomScoresFromPids(int[] pids,int[] states,int[] scores){getProcessStatesFromPids(pids,states);Arrays.fill(scores,0);}
        },false,0);
        try(var listener=HostBinderRpc.listen(socket,HostServices.publishedManager().asBinder(),processes,4)){
            System.out.println(new JSONObject().put("event","ready").put("identity",identity("android","android.system",1000,"u:r:system_server:s0",hostUid)));
            var input=new BufferedReader(new InputStreamReader(System.in));String line;
            while((line=input.readLine())!=null){
                var message=new JSONObject(line);String operation=message.getString("op");
                if(operation.equals("close"))break;
                var identity=peer(message.getJSONObject("peer"));
                if(operation.equals("enroll"))processes.expectIncoming(identity);
                else if(operation.equals("retire"))processes.unavailable(identity);
                else throw new AssertionError(operation);
                System.out.println(new JSONObject().put("event",operation).put("pid",identity.pid()));
            }
        }finally{processes.close();}
    }
    private static void client(String scenario)throws Exception{
        try(var authority=ProcessAuthority.read(5,"example.lazy","example.lazy")){
            HostProcessIdentity.configure(authority.self.uid(),authority.self.hostUid());
            authority.attachPlatform();
            // No HostApplication.prepare(), application context, monitor(context)
            // or Looper.loop() may be needed to finish this synchronous lookup.
            AtomicReference<IBinder> duplicate=new AtomicReference<>();
            AtomicReference<Throwable> duplicateFailure=new AtomicReference<>();
            Thread main=Thread.currentThread();
            check(Looper.getMainLooper().getThread()==main,"Lookup did not originate on the main Looper");
            Thread second=new Thread(()->{
                try{Thread.sleep(100);duplicate.set(HostServices.manager().checkService("processinfo"));}
                catch(Throwable failure){duplicateFailure.set(failure);}
            },"Duplicate profile lookup");second.start();
            Thread witness=new Thread(()->{
                try{
                    long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(3);
                    while(System.nanoTime()<deadline){
                        if(main.getState()==Thread.State.WAITING&&second.getState()==Thread.State.WAITING){System.out.println("{\"event\":\"duplicate\"}");return;}
                        Thread.sleep(5);
                    }
                    throw new AssertionError("Main and duplicate lookups did not both wait for demand");
                }catch(Throwable failure){failure.printStackTrace();System.exit(2);}
            },"Observe concurrent profile demand");witness.setDaemon(true);witness.start();
            IBinder service=null;Throwable failure=null;
            try{service=HostServices.manager().checkService("processinfo");}catch(Throwable stopped){failure=stopped;}
            second.join(3000);check(!second.isAlive(),"Duplicate lookup remained blocked");
            if(scenario.equals("eof")){
                check(failure!=null&&duplicateFailure.get()!=null,"Authority EOF did not fail both waiting lookups");
                System.out.println("PASS authority EOF releases main and duplicate lookup before application monitor or Looper dispatch");
            }else{
                if(failure!=null)throw new AssertionError("Main lookup failed",failure);
                if(duplicateFailure.get()!=null)throw new AssertionError("Duplicate lookup failed",duplicateFailure.get());
                check(service!=null&&duplicate.get()==service,"Duplicate lookup did not share its lazy result");
                int[] states=new int[2];IProcessInfoService.Stub.asInterface(service).getProcessStatesFromPids(new int[]{1,3},states);
                check(Arrays.equals(states,new int[]{41,43}),"Original AIDL response changed");
                System.out.println("PASS early main and duplicate lookups share one authority demand and authenticated native Binder directory");
            }
        }finally{HostRemoteServices.shutdown();}
    }
    public static void main(String[] args)throws Exception{
        int status=0;
        try{
            RuntimeFixture.initialize(args[0],args[1]);
            if(args[2].equals("owner"))owner(args[3],Integer.parseInt(args[4]));else client(args[2]);
        }catch(Throwable failure){failure.printStackTrace();status=1;}
        System.exit(status);
    }
}
