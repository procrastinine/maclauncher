import android.location.Location;
import android.location.LocationManager;
import android.os.*;
import maclauncher.android.location.ManualLocation;
import maclauncher.android.framework.*;
import java.nio.file.*;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

public class LocationProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Path.of(args[1]);
        Looper loop=maclauncher.android.fixture.RuntimeFixture.initialize(args[0],args[1]);
        System.load(System.getProperty("klepton.graphics"));
        Path apk=data.resolve("location.apk");maclauncher.android.fixture.PackageManifest.add(apk,"permissions");
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
        HostContext.hostPackage("org.example.permissions","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),runtime.resolve("native").toString(),35);
        HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostPackages.inspectSources(List.of(apk));HostStorageService.install();HostDisplay.hostPublish(1,320,240,60);
        HostApplication.prepare(LocationProbe.class.getClassLoader());
        var context=HostApplication.applicationContext();HostApplication.attach(new android.app.Application(),context);
        LocationManager manager=context.getSystemService(LocationManager.class);String provider=LocationManager.FUSED_PROVIDER;
        check(manager.isLocationEnabled(),"manual provider is available before a decision");
        check(manager.getAllProviders().equals(List.of(provider)),"only the supplied manual provider is advertised");
        check(manager.getLastKnownLocation(provider)==null,"no default fix");
        check(!ManualLocation.isGranted(),"query did not grant permission");
        AtomicInteger delivered=new AtomicInteger();CancellationSignal canceled=new CancellationSignal();canceled.cancel();
        try{manager.getCurrentLocation(provider,canceled,Runnable::run,value->{throw new AssertionError("cancelled request delivered");});throw new AssertionError("Pre-cancelled original request was accepted");}catch(OperationCanceledException expected){}
        CancellationSignal lateCancel=new CancellationSignal();
        manager.getCurrentLocation(provider,lateCancel,Runnable::run,value->{throw new AssertionError("late cancellation delivered");});
        boolean deny=args[2].equals("deny");
        manager.getCurrentLocation(provider,null,Runnable::run,value->{
            delivered.incrementAndGet();
            if(deny){check(value==null,"denial supplies no substitute fix");return;}
            check(value!=null&&value.isMock()&&value.isComplete(),"explicit mock fix");
            check(value.getLatitude()==12.5&&value.getLongitude()==-33.25&&value.getAccuracy()==25,"entered coordinate retained");
            check(value.getProvider().equals(provider),"requested provider");
            Bundle extras=new Bundle();extras.putString("source","manual");extras.putIntArray("samples",new int[]{1,2});value.setExtras(extras);
            Parcel parcel=Parcel.obtain();value.writeToParcel(parcel,0);parcel.setDataPosition(0);Location restored=Location.CREATOR.createFromParcel(parcel);parcel.enforceNoDataAvail();parcel.recycle();
            check(restored.isMock()&&restored.getLongitude()==-33.25&&restored.getExtras().getIntArray("samples")[1]==2,"location parcel preserves data");
            value.setLatitude(0);check(manager.getLastKnownLocation(provider).getLatitude()==12.5,"caller cannot mutate cached fix");
        });
        check(manager.getLastKnownLocation(provider)==null,"pending request supplies no fix");
        // Emulate the native dialog completion before pumping the queued show.
        // The retired show callback must do nothing, so no UI/native library loads.
        ManualLocation.complete(1,deny?null:new double[]{12.5,-33.25,25});
        lateCancel.cancel();HostLooper.drain(loop);check(delivered.get()==1,"single coalesced delivery");
        check(manager.isLocationEnabled()!=deny,"grant follows manual decision");
        manager.getCurrentLocation(provider,null,Runnable::run,value->{check((value==null)==deny,"same-session decision");delivered.incrementAndGet();});
        HostLooper.drain(loop);check(delivered.get()==2,"same-session reply");
        HostApplication.shutdown();HostLooper.close(loop);check(!ManualLocation.isGranted()&&ManualLocation.last(provider)==null,"shutdown clears coordinates");
        FrameworkResources.shutdown();
        System.out.println("PASS requested manual location "+(deny?"denied":"granted"));
        System.exit(0);
    }
}
