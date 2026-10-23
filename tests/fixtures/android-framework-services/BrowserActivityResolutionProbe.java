package maclauncher.android;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.*;
import java.nio.file.*;
import java.util.List;
import maclauncher.android.bridge.WebLinks;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.RuntimeFixture;

/** Real PackageManager resolution precedes the native browser fallback. */
public final class BrowserActivityResolutionProbe {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Looper loop=RuntimeFixture.initialize(args[0],args[1]);System.load(System.getProperty("klepton.graphics"));
  Path data=Path.of(args[1]),apk=data.resolve("browser-intents.apk");SyntheticResources.apk(apk,"","Browser intents",null);
  maclauncher.android.fixture.PackageManifest.add(apk,"window");FrameworkResources.configure(Path.of(args[0],"android-framework.jar"),List.of(apk));
  HostContext.hostPackage("org.example.window","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);
  HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostPackages.inspectSources(List.of(apk));
  HostApplication.prepare(BrowserActivityResolutionProbe.class.getClassLoader());Context context=HostApplication.applicationContext();WebLinks.hostConfigure(true);
  try{
   Intent intent=new Intent(Intent.ACTION_VIEW,Uri.parse("https://example.invalid/original-activity"))
    .setClassName(context.getPackageName(),"maclauncher.android.HostWindowProbe$OwnedActivity")
    .setDataAndType(Uri.parse("https://example.invalid/original-activity"),"text/html").addCategory("owned.category");
   check(context.getPackageManager().getClass().getName().equals("android.app.ApplicationPackageManager"),"original package client");
   var resolved=context.getPackageManager().resolveActivity(intent,android.content.pm.PackageManager.MATCH_DEFAULT_ONLY);
   check(resolved!=null&&resolved.activityInfo.name.equals(intent.getComponent().getClassName()),"original explicit component resolution");
   int result=ActivityTaskManager.getService().startActivityAsUser(null,context.getPackageName(),null,intent,intent.getType(),null,null,-1,0,null,null,context.getUserId());
   check(result==ActivityManager.START_SUCCESS,"original resolved activity accepted: "+result);
   // The main queue is deliberately not driven: this test covers destination
   // selection, not presentation. HostLooper.close retires its queued creation
   // during teardown, so this component proof never opens a window.
   System.out.println("PASS original Android activity resolution precedes the browser fallback");
  }finally{
   WebLinks.hostShutdown();HostApplication.shutdown();HostPackages.hostClearProviders();FrameworkResources.shutdown();HostLooper.close(loop);HostContext.hostShutdown();
  }
 }
}
