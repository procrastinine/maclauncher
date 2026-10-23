import java.nio.charset.StandardCharsets;
import java.nio.file.*;
public final class PathProbe {
 private static native int probe(String core,byte[][] before,byte[][] targets,byte[][] after,String guest,String file,String renamed,String outside,boolean baseline);
 private static byte[][] bytes(String... values){return java.util.Arrays.stream(values).map(s->s.getBytes(StandardCharsets.UTF_8)).toArray(byte[][]::new);}
 public static void main(String[] args)throws Exception{
  System.load(args[0]);Path work=Path.of(args[2]),physical=work.resolve("physical"),alias=work.resolve("alias");Files.createDirectories(physical);Files.createSymbolicLink(alias,physical);
  Path file=physical.resolve("libdisk.so"),outside=work.resolve("libprivate.so");Files.copy(Path.of(args[3]),file);Files.copy(Path.of(args[3]),outside);
  String guest="/data/app/owned.path/lib/arm64/libdisk.so";
  byte[][] before=bytes("/data/app/owned.path/lib/arm64",physical.toString(),"/data/app/alias/lib/arm64");
  byte[][] targets=bytes(physical.toString(),physical.toString(),alias.toString());
  byte[][] after=bytes("/data/app/replaced/lib/arm64",physical.toString(),"/data/app/newalias/lib/arm64");
  int result=probe(args[1],before,targets,after,guest,file.toString(),physical.resolve("renamed.so").toString(),outside.toString(),Boolean.parseBoolean(args[4]));
  System.exit(result);
 }
}
