package maclauncher.android.framework;
import java.nio.file.*;
import org.json.*;

/** Both VM representations consume the same persistent namespace contract. */
public final class StorageNamespaceProbe {
 private static native byte[] nativeEnvironment(String key);
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[1]),data=Path.of(args[2]),files=data.resolve("files"),cache=data.resolve("cache");String pkg="org.example.namespace";
  if(args[0].equals("art"))HostFilesystem.configureAndroid(data,files,cache,pkg);else HostFilesystem.configure(runtime,data,files,cache,pkg);
  JSONObject expected=new JSONObject(Files.readString(Path.of(args[3])));JSONArray mappings=expected.getJSONArray("mappings");
  for(int i=0;i<mappings.length();i++){
   JSONObject mapping=mappings.getJSONObject(i);String source=mapping.getString("android"),target=mapping.getString("target");
   if(!HostFilesystem.mapPath(source+"/namespace-probe").equals(Path.of(target,"namespace-probe").toString()))throw new AssertionError("Alias differs: "+source);
  }
  if(args.length==5)System.load(args[4]);
  JSONObject environment=expected.getJSONObject("environment");for(String key:environment.keySet()){
   String value=environment.getString(key);
   if(!value.equals(HostFilesystem.environment(key)))throw new AssertionError("Environment differs: "+key);
   if(args.length==5){
    byte[] nativeValue=nativeEnvironment(key);
    if(nativeValue==null||!value.equals(new String(nativeValue,java.nio.charset.StandardCharsets.UTF_8)))throw new AssertionError("Native environment differs: "+key);
    if(!value.equals(System.getenv(key)))throw new AssertionError("JDK environment differs: "+key);
   }
  }
  if(args.length==5&&(System.getenv("MACLAUNCHER_NAMESPACE_SECRET")!=null||nativeEnvironment("MACLAUNCHER_NAMESPACE_SECRET")!=null))throw new AssertionError("Unrelated host environment was inherited");
  if(!Files.readString(HostFilesystem.file(Path.of("/storage/emulated/0/Android/obb",pkg,"retained.obb").toFile()).toPath()).equals("retained expansion bytes"))throw new AssertionError("Persistent expansion assets differ");
  if(args[0].equals("art")&&!HostFilesystem.mapPath("/system/framework/framework-res.apk").equals("/system/framework/framework-res.apk"))throw new AssertionError("ART partitions are already native");
  System.out.println("PASS common storage namespace "+args[0]+", "+mappings.length()+" aliases and retained expansion bytes");
 }
}
