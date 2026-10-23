package maclauncher.android.media;
import android.media.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.MediaServicesFixture;

/** Raw AOSP device enumeration/callbacks against the actual CoreAudio native owner. */
public final class AudioRoutesProbe {
    static void check(boolean condition,String why){if(!condition)throw new AssertionError(why);}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Path.of(args[1]);
        try(var services=new MediaServicesFixture(runtime,data)){
            Looper main=services.loop;AudioManager manager=services.context.getSystemService(AudioManager.class);
            AudioDeviceInfo[] real=manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
            for(AudioDeviceInfo device:real){check(device.getId()>0&&device.isSink()&&!device.isSource()&&device.getChannelCounts()[0]>0,"actual native output description");check(device.getType()!=AudioDeviceInfo.TYPE_UNKNOWN,"actual output transport reaches raw Android filtering");}
            if(real.length>0){
                String rate=manager.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE),frames=manager.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER);
                check(rate!=null&&Arrays.stream(real[0].getSampleRates()).anyMatch(value->value==Integer.parseInt(rate)),"original AudioManager property agrees with the actual output route");
                check(frames!=null&&Integer.parseInt(frames)>0,"native output buffer size reaches original AudioManager");
                check(AudioSystem.getOutputLatency(AudioManager.STREAM_MUSIC)>=0,"native hardware scheduling latency is available");
                int deviceType=AudioDeviceInfo.convertDeviceTypeToInternalDevice(real[0].getType());
                check(AudioSystem.getDeviceConnectionState(deviceType,real[0].getAddress())==1,"actual CoreAudio output is connected by type and address");
                check(AudioSystem.getDeviceConnectionState(deviceType,"missing-device-"+UUID.randomUUID())==0,"unavailable CoreAudio device is not advertised");
            }
            int[] added={0};AudioDeviceCallback callback=new AudioDeviceCallback(){public void onAudioDevicesAdded(AudioDeviceInfo[] devices){check(Thread.currentThread()==main.getThread(),"Android dispatches to the requested thread");added[0]+=devices.length;}};
            manager.registerAudioDeviceCallback(callback,new Handler(main));HostLooper.drain(main);manager.unregisterAudioDeviceCallback(callback);
            check(added[0]==real.length,"raw initial callback inventory");
            var field=AudioManager.class.getDeclaredField("mDeviceCallbacks");field.setAccessible(true);check(((Map<?,?>)field.get(manager)).isEmpty(),"raw callback registration retired");
        }
        System.out.println("PASS original AudioManager CoreAudio ports, native event owner, Android callbacks and shutdown");
        System.exit(0);
    }
}
