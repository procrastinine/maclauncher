import android.os.*;
import android.os.Process;
import com.android.server.HostSchedulingPolicy;
import maclauncher.android.fixture.RuntimeFixture;

public final class SchedulingPolicyProbe {
    private static native int install(String directory,String command);
    private static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception {
        RuntimeFixture.initialize(args[0],args[1]);
        System.load(args[2]);
        int self=install(args[3],"scheduling-policy-fixture");
        require(java.util.Arrays.equals(Process.getPidsForCommands(new String[]{"scheduling-policy-fixture"}),new int[]{self}),"Command discovery must return the existing logical lease");
        require(Process.getThreadGroupLeader(self)==self,"Original Process must read the leased thread-group identity");
        require(Process.getUidForPid(self)==1000,"Original Process must read the Android principal, not the Mac UID");
        long[] identity={-1,-1,-1};
        Process.readProcLines("/proc/"+self+"/status",new String[]{"Tgid:","Uid:","AbsentField:"},identity);
        require(java.util.Arrays.equals(identity,new long[]{self,1000,0}),"Readable status must retain original field parsing and zero absent fields");
        long[] missing={-7};Process.readProcLines("/proc/2147483647/status",new String[]{"Tgid:"},missing);
        require(missing[0]==-7,"An absent lease must preserve the caller's sentinel");
        long before=System.nanoTime();
        try(var owner=new HostSchedulingPolicy()){
            IBinder service=ServiceManager.checkService("scheduling_policy");
            require(service!=null,"Native scheduling client must find the published service immediately");
            require(service.getInterfaceDescriptor().equals("android.os.ISchedulingPolicyService"),"Published service must retain the original complete AIDL");
            ISchedulingPolicyService original=ISchedulingPolicyService.Stub.asInterface(service);
            require(original.requestPriority(self,self,0,false)==-1,"Original priority validation must be retained");
            require(original.requestPriority(self,Integer.MAX_VALUE,1,false)==-1,"A retired or nonexistent TID must decline promptly");
            require(original.requestCpusetBoost(true,new Binder())==-1,"Absent media.swcodec must retain the original result");
            require(System.nanoTime()-before<2_000_000_000L,"An unavailable RT request must not wait for a missing service");
        }
        require(ServiceManager.checkService("scheduling_policy")==null,"System owner must retire its original Binder endpoint");
        require(Thread.getAllStackTraces().keySet().stream().noneMatch(thread->thread.isAlive()&&thread.getName().startsWith("system-server-init-thread")),"Original initialization workers must retire");
        System.out.println("PASS original scheduling service publication, native lease queries and prompt negative replies");
        System.exit(0);
    }
}
