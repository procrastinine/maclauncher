package maclauncher.android;
import android.content.*;
import android.media.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.MediaServicesFixture;

/** Original AudioManager, AudioService volume policy and Android broadcasts. */
public final class RingerModeProbe {
 private static void check(boolean ok,String message){if(!ok)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),data=Path.of(args[1]);
  try(var services=new MediaServicesFixture(runtime,data)){
  Looper loop=services.loop;Context context=services.context;
  AudioManager audio=context.getSystemService(AudioManager.class);
  var actions=new ArrayList<Integer>();
  BroadcastReceiver receiver=new BroadcastReceiver(){public void onReceive(Context c,Intent i){actions.add(i.getIntExtra(AudioManager.EXTRA_RINGER_MODE,-1));}};
  context.registerReceiver(receiver,new IntentFilter(AudioManager.RINGER_MODE_CHANGED_ACTION),Context.RECEIVER_NOT_EXPORTED);
  HostLooper.drain(loop);actions.clear();
  check(audio.getRingerMode()==AudioManager.RINGER_MODE_NORMAL&&audio.getRingerModeInternal()==AudioManager.RINGER_MODE_NORMAL,"initial ringer state");
  check(audio.getMode()==AudioManager.MODE_NORMAL,"original AudioManager reads the shared mixer's media mode");
  int ring=Math.max(1,audio.getStreamMaxVolume(AudioManager.STREAM_RING)/2),music=Math.max(1,audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)/2);
  audio.setStreamVolume(AudioManager.STREAM_RING,ring,0);audio.setStreamVolume(AudioManager.STREAM_MUSIC,music,0);
  audio.setRingerMode(AudioManager.RINGER_MODE_SILENT);HostLooper.drain(loop);
  check(audio.getRingerModeInternal()==AudioManager.RINGER_MODE_SILENT,"external/internal shared owner");
  check(audio.getMode()==AudioManager.MODE_NORMAL,"ringer muting does not switch the audio routing mode");
  check(audio.getStreamVolume(AudioManager.STREAM_RING)==0&&audio.isStreamMute(AudioManager.STREAM_RING),"ring policy muted");
  check(audio.getStreamVolume(AudioManager.STREAM_MUSIC)==music&&!audio.isStreamMute(AudioManager.STREAM_MUSIC),"music independent of ringer state");
  check(audio.getLastAudibleStreamVolume(AudioManager.STREAM_RING)==ring,"ringer mute retains volume");
  check(actions.equals(List.of(AudioManager.RINGER_MODE_SILENT)),"one real Android change broadcast");
  for(String action:List.of(AudioManager.RINGER_MODE_CHANGED_ACTION,AudioManager.INTERNAL_RINGER_MODE_CHANGED_ACTION))
   check(context.registerReceiver(null,new IntentFilter(action)).getIntExtra(AudioManager.EXTRA_RINGER_MODE,-1)==AudioManager.RINGER_MODE_SILENT,"sticky ringer state");
  audio.setRingerModeInternal(AudioManager.RINGER_MODE_NORMAL);HostLooper.drain(loop);
  check(!audio.isStreamMute(AudioManager.STREAM_RING)&&audio.getStreamVolume(AudioManager.STREAM_RING)==ring,"original volume restored");
  check(audio.isStreamAffectedByRingerMode(AudioManager.STREAM_RING)&&!audio.isStreamAffectedByRingerMode(AudioManager.STREAM_MUSIC),"ringer stream classification");
  IAudioService service=IAudioService.Stub.asInterface(ServiceManager.getService("audio"));
  check(service.isValidRingerMode(0)&&service.isValidRingerMode(2)&&!service.isValidRingerMode(3),"mode range");
  try{service.setRingerModeExternal(3,context.getPackageName());throw new AssertionError("invalid mode accepted");}catch(IllegalArgumentException expected){}
  context.unregisterReceiver(receiver);
  }
  System.out.println("PASS original ringer APIs, sticky broadcasts and original volume policy");
  System.exit(0);
 }
}
