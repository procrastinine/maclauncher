package maclauncher.android;
import java.nio.file.*;
import android.view.KeyEvent;
import maclauncher.android.framework.*;
public final class SensorPublicationProbe{
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]).toRealPath(),data=Files.createDirectories(Path.of(args[1])).toRealPath();
  var looper=maclauncher.android.fixture.RuntimeFixture.initialize(runtime.toString(),data.toString());
  HostSensors.configure("keyboard");
  try(var source=HostSensorPublication.open(data.resolve("neutral"))){Thread.sleep(50);}
  try(var source=HostSensorPublication.open(data.resolve("tilted"))){
   if(!HostSensors.key(new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_Q)))throw new AssertionError("Shared Q tilt");Thread.sleep(220);
  }
  HostSensors.key(new KeyEvent(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_Q));HostSensors.configure("off");
  try(var source=HostSensorPublication.open(data.resolve("off"))){}
  HostSensors.shutdown();HostLooper.close(looper);
  System.out.println("PASS shared sensor publication and retirement");System.exit(0);
 }
}
