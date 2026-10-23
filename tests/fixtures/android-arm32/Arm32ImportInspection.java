package maclauncher.android;

import java.nio.file.*;
import org.json.*;

/** No application, Activity, window or application native library is created. */
public final class Arm32ImportInspection {
 private static native String[][] probe(String[] names,String runtime);
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),data=Path.of(args[1]);Files.createDirectories(data.resolve("files"));Files.createDirectories(data.resolve("cache"));
  RuntimeBootstrap.initialize(runtime,data,data.resolve("files"),data.resolve("cache"),"org.maclauncher.nativeinspection",false,false,false);
  maclauncher.android.bridge.NativeSurface.configureGraphics(System.getProperty("klepton.graphics"));
  maclauncher.android.bridge.NativeSurface.install(runtime.resolve("native/libklepton-jvm.dylib").toString());
  System.load(args[2]);JSONArray requested=new JSONArray(Files.readString(Path.of(args[3])));String[] names=new String[requested.length()];for(int n=0;n<names.length;n++)names[n]=requested.getString(n);
  JSONArray result=new JSONArray();String[] fields={"name","owner","ownerSymbol","declaration","stage","error","signature","conversion"};
  for(String[] row:probe(names,runtime.toString())){JSONObject value=new JSONObject();for(int n=0;n<fields.length;n++)value.put(fields[n],row[n]);result.put(value);}
  Files.writeString(Path.of(args[4]),result.toString(2));
  System.out.println("PASS isolated shared native owner/signature/conversion inspection; no application ELF or function executed");
  System.exit(0);
 }
}
