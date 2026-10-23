import android.hardware.input.IInputManager;
import android.hardware.input.InputManagerGlobal;
import android.os.Looper;
import android.os.ServiceManager;
import android.view.*;
import java.io.*;
import java.lang.reflect.*;
import java.util.*;
import maclauncher.android.framework.*;

/** Actual ART device initialization order, without a physical window. */
public final class ArtInputDeviceProbe {
    private static Field field(Class<?> type,String name)throws Exception{Field result=type.getDeclaredField(name);result.setAccessible(true);return result;}
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args){
        int status=0;
        try{run(Integer.parseInt(args[0]));}catch(Throwable failure){failure.printStackTrace(new PrintStream(new FileOutputStream(FileDescriptor.err)));status=1;}
        System.exit(status);
    }
    private static void run(int hostUid)throws Exception{
        if(Looper.getMainLooper()==null)Looper.prepareMainLooper();
        field(ServiceManager.class,"sServiceManager").set(null,HostServices.manager());
        System.load("/system/lib64/libart-authority.so");System.load("/system/lib64/libart-rpc.so");System.load("/system/lib64/libart-platform.so");
        Class<?> platform=Class.forName("maclauncher.android.ArtPlatform");
        Method rpc=platform.getDeclaredMethod("initializeRpc",int.class);rpc.setAccessible(true);rpc.invoke(null,hostUid);
        Method keyboard=platform.getDeclaredMethod("keyboard",String.class);keyboard.setAccessible(true);
        HostInput.keyboardLoader(contents->{try{return (KeyCharacterMap)keyboard.invoke(null,contents);}catch(ReflectiveOperationException error){throw new IllegalStateException(error);}});
        // This ordering matches the actual shared application bootstrap.
        HostInput.initialize();
        HostInputManager.install();
        int[] ids=InputDevice.getDeviceIds();
        check(Arrays.stream(ids).anyMatch(value->value==-1)&&Arrays.stream(ids).anyMatch(value->value==1),"Original InputDevice enumeration lost the keyboard or pointer: "+Arrays.toString(ids));
        InputDevice pointer=InputDevice.getDevice(1),keys=InputDevice.getDevice(-1);
        check(pointer!=null&&keys!=null,"Original InputDevice lookup must resolve both published devices");
        check(pointer.supportsSource(InputDevice.SOURCE_TOUCHSCREEN),"Original pointer must advertise touchscreen events");
        check(keys.getKeyCharacterMap().get(KeyEvent.KEYCODE_A,KeyEvent.META_SHIFT_ON)=='A',"Original libinput parser must retain the supplied virtual key map");
        Object global=InputManagerGlobal.getInstance(),bound=field(InputManagerGlobal.class,"mIm").get(global),owner=field(HostInputManager.class,"SERVICE").get(null);
        check(bound==owner,"Original InputManagerGlobal must use the existing process-local input owner: "+bound.getClass().getName());
        check(((IInputManager)bound).getInputDevice(1)==pointer,"Original global lookup must retain the actual published pointer");
        MotionEvent down=HostInput.motion(MotionEvent.ACTION_DOWN,17,23);
        try{check(down.getDeviceId()==1&&down.getSource()==InputDevice.SOURCE_TOUCHSCREEN&&down.getDevice()==pointer,"Original MotionEvent.getDevice must resolve the same touchscreen device");}
        finally{down.recycle();HostInput.motion(MotionEvent.ACTION_UP,17,23).recycle();}
        var metrics=new android.util.DisplayMetrics();HostDisplay.metrics(metrics);int generation=pointer.getGeneration();
        Method viewport=HostInput.class.getDeclaredMethod("viewportChanged",int.class,int.class);viewport.setAccessible(true);viewport.invoke(null,metrics.widthPixels+16,metrics.heightPixels+8);
        HostLooper.drain(Looper.getMainLooper());
        InputDevice changed=InputDevice.getDevice(1);
        check(changed!=null&&changed.getGeneration()==generation+1,"Original device cache must observe pointer generation changes");
        check(changed.getAssociatedDisplayId()==android.view.Display.DEFAULT_DISPLAY,"Pointer must retain the original default Android display identity");
        check(changed.getMotionRange(MotionEvent.AXIS_X,InputDevice.SOURCE_TOUCHSCREEN).getMax()==metrics.widthPixels+15&&changed.getMotionRange(MotionEvent.AXIS_Y,InputDevice.SOURCE_TOUCHSCREEN).getMax()==metrics.heightPixels+7,"Original motion ranges must reflect the published viewport");
        new PrintStream(new FileOutputStream(FileDescriptor.out)).println("PASS original ART input devices: initialize before install, ids="+Arrays.toString(ids)+", MotionEvent.getDevice=1, local InputManagerGlobal, libinput keyboard and generation "+generation+"->"+changed.getGeneration()+", default extent "+metrics.widthPixels+"x"+metrics.heightPixels);
    }
}
