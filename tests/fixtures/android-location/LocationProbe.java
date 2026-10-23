import android.location.Location;
import android.location.LocationManager;
import android.os.*;
import maclauncher.android.location.ManualLocation;
import java.util.concurrent.atomic.AtomicInteger;

public class LocationProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args){
        Looper loop=Looper.hostMain();LocationManager manager=new LocationManager();
        check(!manager.isLocationEnabled(),"initially disabled");
        check(manager.getLastKnownLocation("gps")==null,"no default fix");
        check(!ManualLocation.isGranted(),"query did not grant permission");
        AtomicInteger delivered=new AtomicInteger();CancellationSignal canceled=new CancellationSignal();canceled.cancel();
        manager.getCurrentLocation("gps",canceled,Runnable::run,value->{throw new AssertionError("cancelled request delivered");});
        CancellationSignal lateCancel=new CancellationSignal();
        manager.getCurrentLocation("gps",lateCancel,Runnable::run,value->{throw new AssertionError("late cancellation delivered");});
        boolean deny=args.length>0&&args[0].equals("deny");
        manager.getCurrentLocation("network",null,Runnable::run,value->{
            delivered.incrementAndGet();
            if(deny){check(value==null,"denial supplies no substitute fix");return;}
            check(value!=null&&value.isMock()&&value.isComplete(),"explicit mock fix");
            check(value.getLatitude()==12.5&&value.getLongitude()==-33.25&&value.getAccuracy()==25,"entered coordinate retained");
            check(value.getProvider().equals("network"),"requested provider");
            Bundle extras=new Bundle();extras.putString("source","manual");extras.putIntArray("samples",new int[]{1,2});value.setExtras(extras);
            Parcel parcel=Parcel.obtain();value.writeToParcel(parcel,0);parcel.setDataPosition(0);Location restored=Location.CREATOR.createFromParcel(parcel);parcel.enforceNoDataAvail();parcel.recycle();
            check(restored.isMock()&&restored.getLongitude()==-33.25&&restored.getExtras().getIntArray("samples")[1]==2,"location parcel preserves data");
            value.setLatitude(0);check(manager.getLastKnownLocation("gps").getLatitude()==12.5,"caller cannot mutate cached fix");
        });
        check(manager.getLastKnownLocation("gps")==null,"pending request supplies no fix");
        // Emulate the native dialog completion before pumping the queued show.
        // The retired show callback must do nothing, so no UI/native library loads.
        ManualLocation.complete(1,deny?null:new double[]{12.5,-33.25,25});
        lateCancel.cancel();loop.hostDrain();check(delivered.get()==1,"single coalesced delivery");
        check(manager.isLocationEnabled()!=deny,"grant follows manual decision");
        manager.getCurrentLocation("gps",null,Runnable::run,value->{check((value==null)==deny,"same-session decision");delivered.incrementAndGet();});
        loop.hostDrain();check(delivered.get()==2,"same-session reply");
        loop.quit();check(!ManualLocation.isGranted()&&manager.getLastKnownLocation("gps")==null,"shutdown clears coordinates");
        System.out.println("PASS requested manual location "+(deny?"denied":"granted"));
    }
}
