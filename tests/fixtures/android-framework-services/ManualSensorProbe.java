package maclauncher.android;

import android.app.Application;
import android.content.Context;
import android.hardware.*;
import android.os.*;
import android.view.KeyEvent;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import maclauncher.android.framework.*;

/** Original sensor enumeration, listener dispatch, flush and retirement. */
public final class ManualSensorProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static void until(Looper looper,java.util.function.BooleanSupplier done)throws Exception{long end=System.nanoTime()+2_000_000_000L;while(!done.getAsBoolean()&&System.nanoTime()<end){HostLooper.drain(looper);Thread.sleep(1);}check(done.getAsBoolean(),"Sensor callback deadline");}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]).toRealPath(),data=Files.createDirectories(Path.of(args[1])).toRealPath();
        Looper loop=maclauncher.android.fixture.RuntimeFixture.initialize(runtime.toString(),data.toString());
        System.load(System.getProperty("klepton.graphics"));
        Path apk=data.resolve("owned.apk");SyntheticResources.locales(apk,new String[]{""},new String[]{"Motion"});maclauncher.android.fixture.PackageManifest.add(apk,"window");
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));HostContext.hostPackage("org.example.window","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);HostPackages.inspectSources(List.of(apk));
        HostContext.hostFilesDirectory(data.resolve("files").toString());HostContext.hostCacheDirectory(data.resolve("cache").toString());HostDisplay.hostPublish(1,320,240,60);
        HostSensors.configure("keyboard");HostApplication.prepare(ManualSensorProbe.class.getClassLoader());Context context=HostApplication.applicationContext();Application app=new Application();HostApplication.attach(app,context);HostApplication.create(app);
        try{
            SensorManager manager=context.getSystemService(SensorManager.class);check(manager.getClass()==SystemSensorManager.class,"Original SystemSensorManager factory");
            Sensor gravity=manager.getDefaultSensor(Sensor.TYPE_GRAVITY),rotation=manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
            check(gravity!=null&&rotation!=null&&manager.getSensorList(Sensor.TYPE_ALL).size()==7,"Complete advertised manual motion family");
            check(manager.getDefaultSensor(Sensor.TYPE_PROXIMITY)==null&&!gravity.isDirectChannelTypeSupported(SensorDirectChannel.TYPE_MEMORY_FILE),"No fabricated physical sensor or direct channel");
            AtomicInteger count=new AtomicInteger(),flushes=new AtomicInteger();float[] latest=new float[3];long[] timestamp={0};
            SensorEventListener2 listener=new SensorEventListener2(){public void onAccuracyChanged(Sensor sensor,int accuracy){}public void onFlushCompleted(Sensor sensor){flushes.incrementAndGet();}public void onSensorChanged(SensorEvent event){check(event.sensor==gravity&&event.timestamp>timestamp[0],"Original listener identity and monotonic timestamps");timestamp[0]=event.timestamp;System.arraycopy(event.values,0,latest,0,3);if(count.incrementAndGet()==1){manager.unregisterListener(this);check(manager.registerListener(this,gravity,SensorManager.SENSOR_DELAY_GAME),"Reentrant original unregister/register");}}};
            check(manager.registerListener(listener,gravity,SensorManager.SENSOR_DELAY_GAME),"Original registration");until(loop,()->count.get()>=2);check(Math.abs(latest[2]-SensorManager.GRAVITY_EARTH)<.01,"Neutral gravity");
            check(!HostSensors.key(new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_DPAD_RIGHT)),"Ordinary arrow input preserved");
            check(HostSensors.key(new KeyEvent(0,0,KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_DPAD_RIGHT,0,KeyEvent.META_ALT_ON)),"Explicit keyboard tilt chord");until(loop,()->latest[0]<-4);
            check(manager.flush(listener),"Original flush request");until(loop,()->flushes.get()==1);
            HostSensors.key(new KeyEvent(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_DPAD_RIGHT));until(loop,()->Math.abs(latest[0])<.01);
            check(!HostSensors.key(new KeyEvent(0,0,KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_Q,0,KeyEvent.META_META_ON)),"Native Cmd-Q shortcut preserved");
            check(!HostSensors.key(new KeyEvent(0,0,KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_E,0,KeyEvent.META_CTRL_ON)),"Control shortcut preserved");
            for(int key:new int[]{KeyEvent.KEYCODE_W,KeyEvent.KEYCODE_A,KeyEvent.KEYCODE_S,KeyEvent.KEYCODE_D})
                check(!HostSensors.key(new KeyEvent(KeyEvent.ACTION_DOWN,key)),"Movement keys remain separate from tilt");
            check(HostSensors.key(new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_Q)),"Q tilts left");until(loop,()->latest[0]>4);
            check(!HostSensors.key(new KeyEvent(0,0,KeyEvent.ACTION_UP,KeyEvent.KEYCODE_Q,0,KeyEvent.META_META_ON)),"Modified key release preserves shortcuts");until(loop,()->Math.abs(latest[0])<.01);
            check(HostSensors.key(new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_E)),"E tilts right");until(loop,()->latest[0]<-4);
            check(HostSensors.key(new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_R)),"R recenters held tilt");until(loop,()->Math.abs(latest[0])<.01);
            HostSensors.key(new KeyEvent(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_R));HostSensors.key(new KeyEvent(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_E));
            manager.unregisterListener(listener);int ended=count.get();long stop=System.nanoTime()+80_000_000;while(System.nanoTime()<stop){HostLooper.drain(loop);Thread.sleep(1);}check(count.get()==ended,"No callbacks after original unregister");
            HostSensors.configure("off");check(new SystemSensorManager(context,loop).getSensorList(Sensor.TYPE_ALL).isEmpty(),"Disabled manual motion exposes no sensors");
            for(int key:new int[]{KeyEvent.KEYCODE_Q,KeyEvent.KEYCODE_E,KeyEvent.KEYCODE_R})check(!HostSensors.key(new KeyEvent(KeyEvent.ACTION_DOWN,key)),"Disabled tilt preserves game keys");
        }finally{HostSensors.shutdown();HostApplication.shutdown();HostWindowManager.shutdown();HostDisplay.hostShutdown();HostDisplay.hostRemove();FrameworkResources.shutdown();HostLooper.close(loop);HostContext.hostShutdown();}
        System.out.println("PASS original sensor factory, manual motion, reentrant listeners, flush and callback retirement");
    }
}
