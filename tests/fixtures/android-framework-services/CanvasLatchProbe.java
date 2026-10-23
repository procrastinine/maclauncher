package maclauncher.android;

import android.app.Activity;
import android.os.Looper;
import android.view.SurfaceControl;
import maclauncher.android.bridge.CanvasFrameSource;
import maclauncher.android.framework.*;

/** Original transaction callbacks follow the shared output consumer, not its Mac backend. */
public final class CanvasLatchProbe {
    private static void check(boolean value,String text){if(!value)throw new AssertionError(text);}
    public static void run(Activity activity,Looper loop)throws Exception{
        HostWindowManager.detachOutput();
        final class Backend implements CanvasFrameSource.Backend {
            boolean blocked=true;int attempts,accepted;long frame;int[] image;
            public void resize(int width,int height){}
            public boolean submit(int[] pixels,int width,int height,long id,long time){
                attempts++;if(blocked)return false;accepted++;frame=id;image=pixels.clone();return true;
            }
        }
        var backend=new Backend();
        try(var source=new CanvasFrameSource(activity,backend,320,240)){
            var field=CanvasFrameSource.class.getDeclaredField("root");field.setAccessible(true);
            var root=(SurfaceControl)field.get(source);
            HostWindowProbe.pump(loop);
            int[] completed={0},committed={0};long[] times=new long[3];
            long before=System.nanoTime();
            try(var first=new SurfaceControl.Transaction();var second=new SurfaceControl.Transaction()){
                first.setAlpha(root,1).setMatrix(root,0,-1,1,0).addTransactionCommittedListener(Runnable::run,()->committed[0]++)
                    .addTransactionCompletedListener(Runnable::run,stats->{times[completed[0]++]=stats.getLatchTimeNanos();try(var fence=stats.getPresentFence()){check(!fence.isValid(),"latch may have the original empty present fence");}});
                first.sanitize(android.os.Process.myPid(),android.os.Process.myUid());first.apply();
                var lookup=HostSurfaceControl.class.getDeclaredMethod("layer",long.class);lookup.setAccessible(true);var state=lookup.invoke(null,root.mNativeObject);
                var dtdx=state.getClass().getDeclaredField("dtdx");dtdx.setAccessible(true);
                check(dtdx.getFloat(state)==-1,"sanitize retains a local non-rectangular transform in its app-private scene");
                second.setAlpha(root,.9f).addTransactionCommittedListener(Runnable::run,()->committed[0]++)
                    .addTransactionCompletedListener(Runnable::run,stats->times[completed[0]++]=stats.getLatchTimeNanos()).apply();
                check(committed[0]==2&&completed[0]==0,"commit precedes output latch");
                HostWindowProbe.pump(loop);
                check(completed[0]==2&&times[0]==times[1]&&times[0]>=before&&times[0]<=System.nanoTime(),"coalesced transactions receive the actual accepted frame latch");
                check(backend.attempts==0,"Android latch does not need a Mac drawable or backend pump");
                check(source.pump(System.nanoTime())==CanvasFrameSource.BUSY&&backend.attempts==1,"backend backpressure remains real");
                check(completed[0]==2&&source.statistics()[4]==1,"blocked display does not delay or repeat Android completion");
                first.apply();second.apply();HostWindowProbe.pump(loop);check(completed[0]==2,"retired listeners are not repeated");
            }
            try(var newer=new SurfaceControl.Transaction()){
                newer.setAlpha(root,1).setMatrix(root,1,0,0,1).addTransactionCompletedListener(Runnable::run,stats->times[completed[0]++]=stats.getLatchTimeNanos()).apply();
                HostWindowProbe.pump(loop);check(completed[0]==3&&times[2]>=times[1],"newer accepted frame subsumes pending pixels with its own latch");
            }
            backend.blocked=false;
            check(source.pump(System.nanoTime())==CanvasFrameSource.SUBMITTED&&backend.accepted==1&&backend.frame>0,"only the latest queued image reaches the backend");
            check(backend.image.length==320*240&&java.util.Arrays.stream(backend.image).anyMatch(pixel->pixel!=0),"actual Android pixels are retained");
            check(source.pump(System.nanoTime())==CanvasFrameSource.IDLE&&completed[0]==3,"dropped or hidden physical output requires no completion retry");
        long[] emptyLatch={0};long beforeEmpty=System.nanoTime();
        var empty=HostSurfaceControl.rootSurfaceControl("empty-output",1,1,new HostSurface.Target(){
            public boolean submit(int[] pixels,int width,int height,long frame,long time){throw new AssertionError("buffer-free transaction submitted pixels");}
            public void resize(int width,int height){}
        });
        try(var transaction=new SurfaceControl.Transaction()){
            transaction.setAlpha(empty,1).addTransactionCompletedListener(Runnable::run,stats->emptyLatch[0]=stats.getLatchTimeNanos()).apply();
            HostWindowProbe.pump(loop);check(emptyLatch[0]>=beforeEmpty,"buffer-free state change receives its own latch time");
        }finally{empty.release();}
        }
        System.out.println("PASS original transaction latch, coalesced identity, backend backpressure and independent physical display");
    }
}
