package maclauncher.android;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.HostFilesystem;

public final class FusedPathsProbe {
 private static native String readOffset(String path,int offset);
 private static void equal(Object actual,Object expected){if(!Objects.equals(actual,expected))throw new AssertionError(actual+" != "+expected);}
 public static void main(String[] args)throws Exception{
  System.load("/data/local/tmp/libfused-paths.so");
  Path root=Path.of("/data/app/fused"),base=root.resolve("base.apk"),feature=root.resolve("actual-feature.apk"),alias=root.resolve("split_WorldData.apk");
  var info=new ApplicationInfo();info.metaData=new Bundle();
  info.metaData.putString("com.android.dynamic.apk.fused.modules","base,WorldData,Feature,Existing");
  info.splitNames=new String[]{"Feature"};info.splitSourceDirs=new String[]{feature.toString()};
  var paths=HostFilesystem.fusedArchivePaths(List.of(base,feature),info);
  equal(paths.size(),2);equal(paths.get(alias),base);
  if(Files.exists(alias))throw new AssertionError("Alias exists before publication");
  ArtFilesystem.installPackageAliases(List.of(base,feature),info);
  equal(readOffset(alias.toString(),9),"base ZIP");
  equal(readOffset(root.resolve("split_Feature.apk").toString(),9),"split ZIP");
  equal(readOffset(root.resolve("split_Existing.apk").toString(),0),"real installed split");
  equal(new String(Files.readAllBytes(alias),StandardCharsets.UTF_8),"original base ZIP");
  var a=android.system.Os.stat(alias.toString());var b=android.system.Os.stat(base.toString());
  if(a.st_ino!=b.st_ino||a.st_dev!=b.st_dev||a.st_uid!=b.st_uid||a.st_mode!=b.st_mode)throw new AssertionError("Alias changed inode identity");
  try{android.system.Os.open(alias.toString(),android.system.OsConstants.O_WRONLY,0);throw new AssertionError("Alias became writable");}
  catch(android.system.ErrnoException expected){equal(expected.errno,android.system.OsConstants.EROFS);}
  // The same parsed metadata can be republished without replacing real splits.
  ArtFilesystem.installPackageAliases(List.of(base,feature),info);
  System.out.println("PASS original ART fused APK aliases: shared metadata planner, fopen/fseek, Java read, same inode, real splits win, read-only publication");
 }
}
