package maclauncher.android;

import android.app.*;
import android.content.*;
import android.os.*;
import java.nio.file.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;

/** Uses the original alarm client and actual Android main queue. */
public final class PowerAlarmProbe {
    private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    private static void until(Looper loop,BooleanSupplier condition)throws Exception{long deadline=System.nanoTime()+2_000_000_000L;while(!condition.getAsBoolean()&&System.nanoTime()<deadline){HostLooper.drain(loop);Thread.sleep(2);}check(condition.getAsBoolean(),"queued operation completed");}
    public static void main(String[] args)throws Exception{
        Looper loop=RuntimeFixture.initialize(args[0],args[1]);
        Path data=Path.of(args[1]),apk=data.resolve("power.apk");SyntheticResources.apk(apk,"","Power",null);FrameworkResources.configure(Path.of(args[0],"android-framework.jar"),java.util.List.of(apk));
        HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostDisplay.hostPublish(1,320,240,60);
        HostApplication.prepare(PowerAlarmProbe.class.getClassLoader());Context context=HostApplication.applicationContext();
        try{
            check(android.telephony.TelephonyFrameworkInitializer.getTelephonyServiceManager()!=null,"original telephony bootstrap");
            check(android.media.MediaFrameworkInitializer.getMediaServiceManager()!=null,"original media bootstrap");
            check(android.bluetooth.BluetoothFrameworkInitializer.getBluetoothServiceManager()!=null,"original Bluetooth bootstrap");
            BatteryManager battery=context.getSystemService(BatteryManager.class);
            PowerManager power=context.getSystemService(PowerManager.class);
            check(battery.getClass()==BatteryManager.class&&power.getClass()==PowerManager.class,"original power clients");
            check(battery.isCharging(),"virtual device is charging");
            check(battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)==100,"virtual battery stays full");
            check(battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_STATUS)==BatteryManager.BATTERY_STATUS_FULL,"virtual full status");
            check(power.isInteractive()&&!power.isPowerSaveMode(),"virtual device remains awake with battery saver off");
            check(power.getCurrentThermalStatus()==PowerManager.THERMAL_STATUS_NONE,"no virtual thermal pressure");
            PowerManager.WakeLock lock=power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"virtual-game-lock");
            lock.acquire();check(lock.isHeld(),"original wake lock acquires a logical token");
            lock.release();check(!lock.isHeld(),"original wake lock releases its token");
            AtomicInteger thermal=new AtomicInteger(-1);
            PowerManager.OnThermalStatusChangedListener thermalListener=thermal::set;
            power.addThermalStatusListener(Runnable::run,thermalListener);check(thermal.get()==PowerManager.THERMAL_STATUS_NONE,"original thermal listener initial callback");power.removeThermalStatusListener(thermalListener);
            BatteryManagerInternal internal=com.android.server.LocalServices.getService(BatteryManagerInternal.class);
            check(internal.isPowered(BatteryManager.BATTERY_PLUGGED_AC)&&internal.getBatteryLevel()==100&&!internal.getBatteryLevelLow(),"virtual battery internal owner agrees");
            internal.setBatteryLevel(17,true);internal.unplugBattery(true);HostLooper.drain(loop);
            check(battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)==17&&!battery.isCharging(),"Android internal battery controls retain their behavior");
            internal.resetBattery(true);HostLooper.drain(loop);
            check(battery.isCharging()&&battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)==100,"reset returns to virtual defaults");
            System.out.println("PASS original battery and thermal clients use virtual state");
            AlarmManager alarm=context.getSystemService(AlarmManager.class);
            check(alarm.getClass()==AlarmManager.class,"original alarm manager client");
            AtomicInteger callbacks=new AtomicInteger();AlarmManager.OnAlarmListener listener=callbacks::incrementAndGet;
            alarm.setExact(AlarmManager.ELAPSED_REALTIME,SystemClock.elapsedRealtime()+30,"delivery",listener,new Handler(loop));until(loop,()->callbacks.get()==1);
            alarm.setExact(AlarmManager.RTC,System.currentTimeMillis()+50,"cancelled",listener,new Handler(loop));alarm.cancel(listener);
            long until=System.nanoTime()+100_000_000L;while(System.nanoTime()<until){HostLooper.drain(loop);Thread.sleep(2);}check(callbacks.get()==1,"cancel removes queued alarm");
            AtomicInteger repeats=new AtomicInteger();IAlarmListener repeated=new IAlarmListener.Stub(){public void doAlarm(IAlarmCompleteListener completed)throws RemoteException{repeats.incrementAndGet();completed.alarmComplete(asBinder());}};
            IAlarmManager alarms=IAlarmManager.Stub.asInterface(ServiceManager.getService(Context.ALARM_SERVICE));alarms.set(context.getPackageName(),AlarmManager.ELAPSED_REALTIME,SystemClock.elapsedRealtime()+10,0,10,0,null,repeated,"repeat",null,null);until(loop,()->repeats.get()>=3);alarms.remove(null,repeated);
            HostApplication.shutdown();HostLooper.close(loop);
            System.out.println("PASS original mainline bootstrap, alarm delivery and retirement");
        }finally{HostApplication.shutdown();HostLooper.close(loop);}
    }
}
