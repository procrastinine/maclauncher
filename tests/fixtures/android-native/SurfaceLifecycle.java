package maclauncher.android.tests;
import android.view.*;
import maclauncher.android.NativeProbeFixture;
import maclauncher.android.framework.HostSurface;
import maclauncher.android.bridge.NativeSurface;
import java.util.*;
public final class SurfaceLifecycle {
 static int checks;
 static void check(boolean value,String text){checks++;if(!value)throw new AssertionError(text);}
 static boolean sameLive(long[] actual,long[] expected){return actual[0]==expected[0]&&actual[1]==expected[1]&&actual[2]==expected[2];}
 public static void main(String[] args)throws Exception {
  var fixture=NativeProbeFixture.current;var baseline=NativeSurface.statistics();
  for(int iteration=0;iteration<24;iteration++){
   var view=new SurfaceView(fixture.context);var holder=view.getHolder();var events=new ArrayList<String>();
   check(!holder.getSurface().isValid(),"Unbound is invalid");check(NativeSurface.acquire(holder.getSurface())==0,"Unbound is not a native window");
   SurfaceHolder.Callback2 callback=new SurfaceHolder.Callback2(){
    public void surfaceCreated(SurfaceHolder h){check(h.isCreating()&&h.getSurface().isValid(),"Created owns actual buffers");events.add("created");}
    public void surfaceChanged(SurfaceHolder h,int format,int width,int height){check(h.getSurface().isValid(),"Changed retains buffers");events.add("changed:"+width+"x"+height);}
    public void surfaceDestroyed(SurfaceHolder h){check(h.getSurface().isValid(),"Producer can release during destroy");events.add("destroyed");}
    public void surfaceRedrawNeeded(SurfaceHolder h){events.add("redraw");}
   };
   holder.addCallback(callback);holder.addCallback(callback);fixture.attach(view,64,48);
   check(events.equals(List.of("created","changed:64x48","redraw")),"Original callback order and duplicate registration: "+events);
   long window=NativeSurface.acquire(holder.getSurface()),storage=NativeSurface.storageId(window),lease=HostSurface.nativeLease(holder.getSurface());
   check(storage>0&&NativeSurface.storageAlive(storage),"Native IOSurface exists");check(Arrays.equals(NativeSurface.geometry(window),new int[]{64,48,1}),"Native geometry matches callbacks");
   NativeSurface.resize(lease,96,72,1);check(Arrays.equals(NativeSurface.geometry(window),new int[]{96,72,1}),"Retained native window observes resized buffers");
   check(NativeSurface.valid(lease)&&!NativeSurface.storageAlive(storage),"Buffer replacement preserves native window identity and retires unused storage");NativeSurface.releaseWindow(window);
   fixture.resize(view,96,72);check(holder.getSurfaceFrame().equals(new android.graphics.Rect(0,0,96,72)),"Original resize updates the surface holder");
   holder.setFixedSize(80,60);fixture.resize(view,100,80);check(holder.getSurfaceFrame().equals(new android.graphics.Rect(0,0,80,60)),"Fixed buffer geometry independent of view");
   holder.setSizeFromLayout();fixture.until(()->holder.getSurfaceFrame().equals(new android.graphics.Rect(0,0,100,80)),"Original layout-sized restoration did not commit");check(holder.getSurfaceFrame().equals(new android.graphics.Rect(0,0,100,80)),"Layout-sized restoration");
   var wrong=new java.util.concurrent.atomic.AtomicReference<Throwable>();Thread thread=new Thread(()->{try{view.getViewRootImpl().requestLayout();}catch(Throwable error){wrong.set(error);}});thread.start();thread.join();check(wrong.get() instanceof ViewRootImpl.CalledFromWrongThreadException,"Original view-root owner check");
   window=NativeSurface.acquire(holder.getSurface());storage=NativeSurface.storageId(window);fixture.detach(view);fixture.detach(view);
   check(!holder.getSurface().isValid()&&NativeSurface.acquire(holder.getSurface())==0,"Destroyed original surface cannot acquire");
   check(NativeSurface.storageAlive(storage),"Native reference retains storage through Java destruction");NativeSurface.releaseWindow(window);check(!NativeSurface.storageAlive(storage),"Final native release retires storage");
   check(sameLive(NativeSurface.statistics(),baseline),"No retained surfaces, references or bytes per cycle");
  }
  var failing=new SurfaceView(fixture.context);var failures=new java.util.concurrent.atomic.AtomicInteger();failing.getHolder().addCallback(new SurfaceHolder.Callback(){public void surfaceCreated(SurfaceHolder h){failures.incrementAndGet();throw new IllegalStateException("intentional callback");}public void surfaceChanged(SurfaceHolder h,int f,int w,int hgt){}public void surfaceDestroyed(SurfaceHolder h){}});
  try{fixture.attach(failing,64,64);check(failures.get()==1&&failing.getHolder().getSurface().isValid(),"Original SurfaceView logs callback failure and retains its surface until teardown");}finally{fixture.detach(failing);}
  check(sameLive(NativeSurface.statistics(),baseline),"Failed creation retires on original window teardown");
  long stale=NativeSurface.create(16,16,1);NativeSurface.release(stale);long replacement=NativeSurface.create(32,32,1);
  try{NativeSurface.resize(stale,64,64,1);throw new AssertionError("Retired lease resized a replacement");}catch(IllegalStateException expected){check(expected.getMessage().contains("resize"),"Retired lease rejected after reallocation");}
  check(NativeSurface.valid(replacement),"Replacement lease remains bound");NativeSurface.release(replacement);
  var leases=new ArrayList<Long>();try{for(int i=0;i<33;i++)leases.add(NativeSurface.create(1,1,1));check(NativeSurface.statistics()[0]==baseline[0]+33,"Independent native windows retain distinct leases");}finally{for(long lease:leases)NativeSurface.release(lease);}
  for(int extent:new int[]{0,-1,8193,Integer.MAX_VALUE})try{NativeSurface.create(extent,1,1);throw new AssertionError("Unsupported extent allocated");}catch(IllegalStateException expected){check(expected.getMessage().contains("dimensions"),"Invalid dimensions are rejected before allocation");}
  check(sameLive(NativeSurface.statistics(),baseline),"Exact baseline live windows/references/bytes");
  System.out.println("PASS "+checks+" checks: original SurfaceView/ViewRoot callbacks, real IOSurface lifetime, resize, failure and bounded allocation");
 }
}
