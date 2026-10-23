import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.hardware.usb.UsbEndpoint;
import android.location.*;
import android.media.*;
import android.net.*;
import android.os.*;
import android.view.*;
import android.graphics.Insets;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.HostFilesystem;
import maclauncher.android.framework.HostNetworkValues;

/** Complete upstream values with actual local service snapshots and storage. */
public final class FrameworkValuesProbe {
    static void check(boolean value,String detail){if(!value)throw new AssertionError(detail);}
    static <T extends Parcelable>T roundTrip(T value,Parcelable.Creator<T> creator){Parcel p=Parcel.obtain();try{value.writeToParcel(p,0);p.setDataPosition(0);return creator.createFromParcel(p);}finally{p.recycle();}}
    public static void main(String[]args)throws Exception{
        Path runtime=Path.of(args[0]).toRealPath(),data=Path.of(args[1]).toRealPath();
        HostFilesystem.configure(runtime,data,data,data,"owned.values");
        System.setProperty("klepton.bridge",runtime.resolve("native/libklepton-jvm.dylib").toString());
        System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
        System.setProperty("klepton.audio",args.length>2?Path.of(args[2]).toAbsolutePath().toString():runtime.resolve("native/libklepton-audio.dylib").toString());
        System.load(System.getProperty("klepton.bridge"));System.load(runtime.resolve("native/libnativebinding.dylib").toString());System.load(System.getProperty("klepton.audio"));
        maclauncher.android.framework.JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));maclauncher.android.framework.JvmNativeMemory.initialize();

        AudioAttributes attrs=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).addTag("owned").build();
        check(AudioAttributes.toLegacyStreamType(attrs)==AudioManager.STREAM_ALARM&&roundTrip(attrs,AudioAttributes.CREATOR).equals(attrs),"raw audio attributes/parcel");
        AudioFormat format=new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(44100).setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build();
        check(format.getChannelCount()==2&&roundTrip(format,AudioFormat.CREATOR).equals(format),"full audio format values");
        var handleClass=Class.forName("android.media.AudioHandle");
        var handleConstructor=handleClass.getDeclaredConstructor(int.class);handleConstructor.setAccessible(true);
        var portConstructor=AudioDevicePort.class.getDeclaredConstructor(handleClass,String.class,int[].class,int[].class,int[].class,int[].class,AudioGain[].class,int.class,String.class,int[].class,int[].class);
        portConstructor.setAccessible(true);
        var port=portConstructor.newInstance(handleConstructor.newInstance(7),"Output",new int[]{48000},new int[]{AudioFormat.CHANNEL_OUT_STEREO},new int[0],new int[]{AudioFormat.ENCODING_PCM_16BIT,AudioFormat.ENCODING_PCM_FLOAT},new AudioGain[0],AudioSystem.DEVICE_OUT_SPEAKER,"owned:7",new int[0],new int[0]);
        var constructor=AudioDeviceInfo.class.getDeclaredConstructor(AudioDevicePort.class);constructor.setAccessible(true);
        AudioDeviceInfo device=constructor.newInstance(port);
        check(device.getId()==7&&device.isSink()&&!device.isSource()&&Arrays.equals(device.getChannelCounts(),new int[]{2})&&Arrays.equals(device.getEncodings(),new int[]{2,4}),"raw audio route descriptor");
        if(args.length>2){var ports=new ArrayList<AudioPort>();check(AudioSystem.listAudioPorts(ports,new int[1])==0,"CoreAudio port query");for(AudioPort route:ports)check(route.id()>0&&route.samplingRates().length>0,"actual CoreAudio descriptor");}

        Location location=new Location("manual");location.setLatitude(1.25);location.setLongitude(-72.5);location.setAccuracy(3);location.setAltitude(25);location.setVerticalAccuracyMeters(4);location.setMock(true);location.setTime(123);location.setElapsedRealtimeNanos(456);
        Location copy=roundTrip(location,Location.CREATOR);check(copy.getLatitude()==1.25&&copy.getVerticalAccuracyMeters()==4&&copy.isMock()&&copy.hasAltitude(),"complete location state/parcel");
        Criteria criteria=new Criteria();criteria.setAccuracy(Criteria.ACCURACY_FINE);criteria.setSpeedAccuracy(Criteria.ACCURACY_HIGH);check(roundTrip(criteria,Criteria.CREATOR).getSpeedAccuracy()==Criteria.ACCURACY_HIGH,"upstream criteria");
        var providerProperties=new android.location.provider.ProviderProperties.Builder().setHasNetworkRequirement(false).setHasSatelliteRequirement(false).setHasSpeedSupport(false).setAccuracy(2).setPowerUsage(1).build();
        check(!providerProperties.hasNetworkRequirement()&&!providerProperties.hasSatelliteRequirement()&&!providerProperties.hasSpeedSupport(),"original provider capability values");

        NetworkCapabilities capabilities=HostNetworkValues.capabilities(1|4);check(capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)&&capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)&&!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),"no invented network validation");
        check(roundTrip(capabilities,NetworkCapabilities.CREATOR).equals(capabilities),"raw network capabilities parcel");
        check(!HostNetworkValues.capabilities(1|4).hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),"unknown route cost is metered");
        check(HostNetworkValues.capabilities(1|4|32|64).hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),"Low Data Mode is independent of metering");
        check(!HostNetworkValues.capabilities(1|4|2|64).hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),"expensive route is metered");
        check(!HostNetworkValues.info(1,4<<8).isConnected()&&HostNetworkValues.info(1,4<<8).isAvailable(),"offline installed transport remains available");
        NetworkInfo info=HostNetworkValues.info(1|8);check(info.isConnected()&&info.getType()==9&&roundTrip(info,NetworkInfo.CREATOR).isConnected(),"raw route info");
        NetworkRequest request=new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build();check(request.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)&&request.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),"raw network request");
        LinkAddress link=new LinkAddress(java.net.InetAddress.getByAddress(new byte[]{127,0,0,1}),8);check(roundTrip(link,LinkAddress.CREATOR).equals(link),"raw address parcel");

        NotificationChannel channel=new NotificationChannel("owned","Channel",3);channel.setDeleted(true);NotificationChannel saved=roundTrip(channel,NotificationChannel.CREATOR);check(saved!=channel&&saved.getName().equals("Channel")&&saved.isDeleted(),"original notification channel state");
        maclauncher.android.framework.NotificationMigrationProbe.run(data);
        WindowInsets insets=new WindowInsets.Builder().setInsets(WindowInsets.Type.statusBars(),Insets.of(0,20,0,0)).build();check(insets.inset(0,5,0,0).getInsets(WindowInsets.Type.statusBars()).top==15,"raw inset composition");
        UsbEndpoint endpoint=new UsbEndpoint(0x81,2,64,4);check(roundTrip(endpoint,UsbEndpoint.CREATOR).getDirection()==0x80,"raw USB descriptors");
        CancellationSignal cancellation=new CancellationSignal();int[] cancelled={0};cancellation.setOnCancelListener(()->cancelled[0]++);cancellation.cancel();cancellation.cancel();check(cancelled[0]==1,"raw cancellation lifecycle");
        LocaleList locales=LocaleList.forLanguageTags("en-US,fr-FR");check(roundTrip(locales,LocaleList.CREATOR).equals(locales),"raw locale parcel");
        check(new ConditionVariable(true).block(1),"upstream condition state");
        System.out.println("PASS complete AOSP value/protocol families and device snapshots");
    }
}
