import android.app.Application;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.ApplicationSettings;
import maclauncher.android.framework.*;
import maclauncher.android.media.MediaInputs;

/** Real per-application media configuration, original permission clients and retirement. */
public final class ProcessMediaProbe {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
 private static void run(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),data=Path.of(args[1]);
  var loop=maclauncher.android.fixture.RuntimeFixture.initialize(args[0],args[1]);
  System.load(System.getProperty("klepton.graphics"));
  Path apk=data.resolve("media.apk");maclauncher.android.fixture.PackageManifest.add(apk,"permissions");
  FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
  HostContext.hostPackage("org.example.permissions","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),runtime.resolve("native").toString(),35);
  HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostPackages.inspectSources(List.of(apk));HostStorageService.install();HostDisplay.hostPublish(1,320,240,60);
  var first=ApplicationSettings.read(Map.of("audioInputUid","fixture-first")::get);
  var second=ApplicationSettings.read(Map.of("audioInputUid","fixture-second","cameraInputUid","fixture-camera")::get);
  check(first.audioInputUid().equals("fixture-first")&&first.cameraInputUid()==null,"settings retain only this application's explicit audio choice");
  check(second.audioInputUid().equals("fixture-second")&&second.cameraInputUid().equals("fixture-camera"),"a different application's choices do not replace the first settings");
  try{ApplicationSettings.read(Map.of("audioInputUid","bad\nidentity")::get);throw new AssertionError("Invalid selection accepted");}catch(java.io.IOException expected){}
  var off=ApplicationSettings.read(key->null);HostContextServices.configureMedia(off);
  HostApplication.prepare(ProcessMediaProbe.class.getClassLoader());Context context=HostApplication.applicationContext();HostApplication.attach(new Application(),context);
  try{
   for(String permission:List.of("android.permission.CAMERA","android.permission.RECORD_AUDIO")){
    check(!MediaInputs.isGranted(permission),"Off has no device grant: "+permission);
    check(context.checkSelfPermission(permission)==PackageManager.PERMISSION_DENIED,"original permission client does not invent an Off grant: "+permission);
   }
   try{HostContextServices.configureMedia(second);throw new AssertionError("Another activation changed immutable media configuration");}catch(IllegalStateException expected){}
   check(!MediaInputs.cameraSelected(),"refused reconfiguration did not select another application's camera");
   AudioManager audio=context.getSystemService(AudioManager.class);int music=AudioManager.STREAM_MUSIC;
   check(!audio.isStreamMute(music),"a fresh application never inherits another process's mute");
   if(args[2].equals("muted")){audio.setStreamMute(music,true);check(audio.isStreamMute(music)&&audio.getStreamVolume(music)==0,"original AudioManager mute reaches this application's output owner");}
   else check(!audio.isStreamMute(music)&&audio.getStreamVolume(music)>0,"a later application's output policy remains independent");
  }finally{
   Throwable failure=HostContextServices.retireApplication(null,null);failure=HostContextServices.retireContext(failure,loop);if(failure!=null)throw new AssertionError("Media owner retirement",failure);
  }
  check(!MediaInputs.isGranted("android.permission.RECORD_AUDIO")&&!MediaInputs.cameraSelected(),"retirement clears the application's selections and grants");
  try{HostContextServices.configureMedia(off);throw new AssertionError("Retired process media configuration reopened");}catch(IllegalStateException expected){}
  System.out.println("PASS media application isolation, original permission/mute clients and retirement "+args[2]);
 }
}
