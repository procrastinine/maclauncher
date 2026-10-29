import android.os.Build;
import android.os.SystemProperties;
public final class PropertyFamilyProbe {
 public static void main(String[] args) {
  System.load(args[0]); System.load(args[1]);
  maclauncher.android.framework.JvmNativeMemory.configure(java.nio.file.Path.of(args[0]).resolveSibling("libandroid_runtime.dylib"));
  if(!SystemProperties.get("ro.product.model").equals("Android"))throw new AssertionError("Property owner");
  if(SystemProperties.getInt("ro.build.version.sdk",-1)!=36)throw new AssertionError("Integer value");
  if(SystemProperties.getLong("missing.property",93)!=93||!SystemProperties.getBoolean("missing.property",true))throw new AssertionError("Defaults");
  var handle=SystemProperties.find("ro.build.version.sdk");
  if(handle==null||!handle.get().equals("36")||handle.getInt(-1)!=36||handle.getLong(-1)!=36)throw new AssertionError("Opaque owner handle");
  if(SystemProperties.find("missing.property")!=null)throw new AssertionError("Missing handle");
  if(!Build.MODEL.equals("Android")||Build.VERSION.SDK_INT!=36||!Build.CPU_ABI.equals("arm64-v8a"))throw new AssertionError("Raw AOSP Build");
  if(!Build.VERSION.CODENAME.equals("REL"))throw new AssertionError("Release identity");
  if(Build.VERSION.RESOURCES_SDK_INT!=36)throw new AssertionError("Resource version "+Build.VERSION.RESOURCES_SDK_INT);
  for(int i=0;i<1000;i++)if(SystemProperties.find("ro.build.version.sdk").getInt(-1)!=36)throw new AssertionError("Repeated handles");
  try{SystemProperties.set("ro.product.model","changed");throw new AssertionError("Read-only property accepted a write");}catch(SecurityException expected){}
  if(!Build.MODEL.equals(SystemProperties.get("ro.product.model")))throw new AssertionError("Owners disagree");
  // The host identifier service withholds the device serial as Build.UNKNOWN.
  maclauncher.android.framework.HostIdentity.install();
  if(!Build.getSerial().equals(Build.UNKNOWN))throw new AssertionError("Private device identifier was exposed");
  System.out.println("PASS raw AOSP Build/SystemProperties, shared native values and borrowed owner handles");
 }
}
