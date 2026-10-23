package maclauncher.android.fixture;
import android.os.Debug;
import java.util.Arrays;
public final class DebugMemoryProbe {
    private static native long allocate(long size);
    private static native void release(long address,long size);
    private static void require(boolean okay,String message){if(!okay)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        if(args.length>3)RuntimeFixture.initialize(args[0],args[1],java.nio.file.Path.of(args[0],"native/libklepton-graphics.dylib").toString(),args[2]);
        else RuntimeFixture.initialize(args[0],args[1],args[2]);
        int pid=android.os.Process.myPid();Debug.MemoryInfo before=new Debug.MemoryInfo();
        Debug.getMemoryInfo(before);long rssBefore=Debug.getRss();
        require(rssBefore>1024&&before.getTotalRss()>1024,"original Debug receives actual resident memory in kB");
        var processInfo=maclauncher.android.framework.HostActivityManager.getProcessMemoryInfo(new int[]{pid,-1,pid});
        require(processInfo.length==3&&processInfo[0]!=processInfo[2]&&processInfo[0].getTotalRss()>1024&&processInfo[2].getTotalRss()>1024,"ActivityManager process array retains each requested position and real measurement");
        require(processInfo[1]!=null&&processInfo[1].getTotalRss()==0,"inaccessible PID retains an empty original MemoryInfo");
        require(maclauncher.android.framework.HostActivityManager.getProcessMemoryInfo(new int[0]).length==0,"empty process request is an empty array");
        require(maclauncher.android.framework.HostActivityManager.getProcessPss(new int[]{pid,-1}).length==2,"PSS array retains each requested position");
        long length=32L*1024*1024,address=allocate(length);require(address!=0,"native tagged allocation");
        try{
            Debug.MemoryInfo after=new Debug.MemoryInfo();require(Debug.getMemoryInfo(pid,after),"own PID overload");
            long rssAfter=Debug.getRss(pid,null);
            require(rssAfter-rssBefore>24*1024,"touched pages increase actual task RSS");
            require(after.nativeRss-before.nativeRss>=32*1024,"Mach malloc tag is classified as native resident memory");
            require(after.nativePrivateDirty+after.nativePrivateClean>=32*1024,"actual private resident accounting");
            for(int count=0;count<=5;count++){
                long[] details=new long[count],memtrack=new long[count];Arrays.fill(details,-7);Arrays.fill(memtrack,-9);
                require(Debug.getPss(pid,details,memtrack)==0,"Linux proportional accounting remains unavailable");
                if(count>0)require(details[0]>=32*1024,"USS contains touched private pages");
                if(count>1)require(details[1]==0,"proportional swap unavailable");
                if(count>2)require(details[2]>rssBefore+24*1024,"optional RSS uses kB");
                for(int i=3;i<count;i++)require(details[i]==-7,"out array tail preserved");
                for(int i=0;i<Math.min(4,count);i++)require(memtrack[i]==0,"memtrack unavailable");
                if(count>4)require(memtrack[4]==-9,"memtrack tail preserved");
                Arrays.fill(memtrack,-9);require(Debug.getRss(pid,memtrack)>rssBefore+24*1024,"RSS overload");
                for(int i=0;i<Math.min(4,count);i++)require(memtrack[i]==0,"RSS short memtrack array");
            }
            require(Debug.getPss()==0,"PSS no-arg overload");
            for(var field:Debug.MemoryInfo.class.getFields())if(!java.lang.reflect.Modifier.isStatic(field.getModifiers())&&field.getType()==int.class)field.setInt(after,1234567);
            after.hasSwappedOutPss=true;var other=Debug.MemoryInfo.class.getDeclaredField("otherStats");other.setAccessible(true);Arrays.fill((int[])other.get(after),1234567);
            Debug.getMemoryInfo(after);require(after.getTotalPss()==0&&!after.hasSwappedOutPss&&after.getTotalSwappedOut()==0,"reused MemoryInfo resets unsupported metrics");
            require(Arrays.stream((int[])other.get(after)).noneMatch(v->v==1234567),"all original otherStats reset");
            long[] untouched={123};require(Debug.getRss(-1,untouched)==0&&untouched[0]==123,"unavailable foreign RSS preserves original output semantics");
            require(Debug.getPss(-1,untouched,untouched)==0&&untouched[0]==123,"unavailable foreign PSS");
            after.nativeRss=123;require(!Debug.getMemoryInfo(-1,after)&&after.nativeRss==123,"no access to other host tasks");
        }finally{release(address,length);}
        long released=Debug.getRss();require(released<rssBefore+12*1024,"released pages leave RSS");
        require(Debug.getNativeHeapAllocatedSize()>0&&Debug.getNativeHeapSize()>=Debug.getNativeHeapAllocatedSize(),"existing allocator accounting preserved");
        System.out.println("PASS original Debug: tagged/touched/released Mach pages, RSS kB, memory categories, short arrays, unavailable PSS and isolated PID queries");
    }
}
