package owned.packages;

import android.content.Intent;
import android.os.Binder;
import android.os.IBinder;

public class Service extends android.app.Service {
    public static int created,destroyed;
    public static Service instance;
    @Override public void onCreate(){created++;instance=this;}
    @Override public IBinder onBind(Intent intent){return new Binder();}
    @Override public int onStartCommand(Intent intent,int flags,int id){return START_NOT_STICKY;}
    @Override public void onDestroy(){destroyed++;instance=null;}
}
