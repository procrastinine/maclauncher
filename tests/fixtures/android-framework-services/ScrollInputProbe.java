package maclauncher.android;

import android.app.Activity;
import android.os.Looper;
import android.view.*;
import java.util.*;
import maclauncher.android.framework.*;

public final class ScrollInputProbe {
    private static void check(boolean value,String text){if(!value)throw new AssertionError(text);}
    private static void pump(Looper loop,long millis)throws Exception{long end=System.nanoTime()+millis*1_000_000;do{HostWindowProbe.pump(loop);Thread.sleep(2);}while(System.nanoTime()<end);}
    public static void run(Activity activity,Looper loop)throws Exception {
        class Surface extends View {
            boolean handlesScroll;int scrolls;float horizontal,vertical;final List<MotionEvent> touches=new ArrayList<>();
            Surface(){super(activity);setFocusableInTouchMode(true);}
            @Override public boolean onGenericMotionEvent(MotionEvent event){if(event.getActionMasked()!=MotionEvent.ACTION_SCROLL)return super.onGenericMotionEvent(event);scrolls++;horizontal+=event.getAxisValue(MotionEvent.AXIS_HSCROLL);vertical+=event.getAxisValue(MotionEvent.AXIS_VSCROLL);check(event.isFromSource(InputDevice.SOURCE_MOUSE),"original mouse source");return handlesScroll;}
            @Override public boolean onTouchEvent(MotionEvent event){touches.add(MotionEvent.obtain(event));return true;}
            void clear(){touches.forEach(MotionEvent::recycle);touches.clear();scrolls=0;horizontal=vertical=0;}
        }
        Surface view=new Surface();activity.setContentView(view);view.requestFocus();pump(loop,30);
        // A ViewRoot pans its rendered tree when an editor would otherwise be
        // obscured. Screen-to-window ingress must not apply that pan again:
        // the original ViewRoot input stage already adds mCurScrollY once.
        ViewRootImpl root=view.getViewRootImpl();
        var scroll=ViewRootImpl.class.getDeclaredField("mCurScrollY");scroll.setAccessible(true);
        var destination=ViewRootImpl.class.getDeclaredField("mScrollY");destination.setAccessible(true);
        int previousScroll=scroll.getInt(root),previousDestination=destination.getInt(root);
        try{
            destination.setInt(root,17);scroll.setInt(root,17);
            int[] panned=new int[2];view.getLocationOnScreen(panned);
            float screenX=panned[0]+120,screenY=panned[1]+100;
            HostWindowManager.input(HostInput.motion(MotionEvent.ACTION_DOWN,screenX,screenY));HostLooper.drain(loop);
            HostWindowManager.input(HostInput.motion(MotionEvent.ACTION_UP,screenX,screenY));HostLooper.drain(loop);
            check(view.touches.size()==2&&view.touches.stream().allMatch(event->Math.abs(event.getX()-120)<.01f&&Math.abs(event.getY()-100)<.01f),
                    "panned root maps the displayed point once: "+view.touches.stream().map(event->event.getX()+","+event.getY()).toList()+" current="+scroll.getInt(root)+" destination="+destination.getInt(root));
        }finally{destination.setInt(root,previousDestination);scroll.setInt(root,previousScroll);view.clear();}
        int[] location=new int[2];view.getLocationOnScreen(location);float x=location[0]+120,y=location[1]+100;
        view.handlesScroll=true;
        HostInput.wheel(x,y,.25f,-.5f,true);HostInput.wheel(x,y,.75f,-.5f,true);pump(loop,190);
        check(view.scrolls==1&&view.horizontal==1&&view.vertical==-1&&view.touches.isEmpty(),"handled generic scrolling is coalesced and never duplicated as touch");
        view.clear();view.handlesScroll=false;
        HostInput.wheel(x,y,.25f,-.5f,true);HostInput.wheel(x,y,.25f,-.5f,true);pump(loop,30);
        HostInput.wheel(x,y,-.125f,.25f,true);pump(loop,190);
        check(view.scrolls==1,"touch-only stream tests original generic handling only once");
        check(view.touches.size()>=3&&view.touches.getFirst().getActionMasked()==MotionEvent.ACTION_DOWN&&view.touches.getLast().getActionMasked()==MotionEvent.ACTION_UP,"one continuous touch down/move/up sequence");
        MotionEvent first=view.touches.getFirst(),last=view.touches.getLast();ViewConfiguration scale=ViewConfiguration.get(activity);
        check(Math.abs(last.getX()-(first.getX()-.375f*scale.getScaledHorizontalScrollFactor()))<.01f&&Math.abs(last.getY()-(first.getY()-.75f*scale.getScaledVerticalScrollFactor()))<.01f,"both native scroll axes retain direction and fractional distance");
        check(view.touches.stream().allMatch(e->e.getDownTime()==first.getDownTime()&&e.isFromSource(InputDevice.SOURCE_TOUCHSCREEN)),"single original touch identity");
        view.clear();HostInput.wheel(x,y,0,-1,true);pump(loop,30);HostWindowManager.focusOutput(false);pump(loop,20);
        check(view.touches.getLast().getActionMasked()==MotionEvent.ACTION_CANCEL,"focus loss cancels drag");HostWindowManager.focusOutput(true);pump(loop,20);
        view.clear();HostInput.wheel(x,y,0,-1,false);pump(loop,190);check(view.scrolls==1&&view.touches.isEmpty(),"captured pointer keeps original scroll without synthesized touch");
        view.clear();HostInput.wheel(x,y,0,-1,true);pump(loop,30);HostWindowManager.input(HostInput.motion(MotionEvent.ACTION_DOWN,x,y));pump(loop,20);
        check(view.touches.stream().filter(e->e.getActionMasked()==MotionEvent.ACTION_CANCEL).count()==1,"physical press cancels synthetic drag before its own down");
        HostInput.wheel(x,y,0,-1,true);pump(loop,190);
        check(view.touches.stream().filter(e->e.getActionMasked()==MotionEvent.ACTION_DOWN).count()==2,"wheel does not start a second touch during physical drag");
        HostWindowManager.input(HostInput.motion(MotionEvent.ACTION_UP,x,y));pump(loop,20);view.clear();
        HostInput.wheel(x,y,0,-1,true);pump(loop,30);HostActivity.finish(activity);HostWindowManager.detachPresentation();pump(loop,190);
        var field=HostWindowManager.class.getDeclaredField("inputCompletions");field.setAccessible(true);check(((Map<?,?>)field.get(null)).isEmpty(),"retirement retains no input completions");view.clear();
        System.out.println("PASS original ViewRoot scroll handling, coalesced two-axis touch fallback, focus/physical input cancellation and retirement");
    }
}
