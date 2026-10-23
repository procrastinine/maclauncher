package maclauncher.android.bridge;
import java.nio.*;import java.nio.file.*;import java.nio.charset.StandardCharsets;import java.io.IOException;import java.util.*;
public final class MetadataProbe {
 static int checks;static void check(boolean value){checks++;if(!value)throw new AssertionError("metadata check "+checks);}
 static byte[] elf(String... names){
  int strings=512+names.length*16;byte[] bytes=new byte[strings+names.length*256+16];ByteBuffer b=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
  b.putInt(0,0x464c457f);b.put(4,(byte)2);b.put(5,(byte)1);b.putShort(18,(short)183);b.putLong(40,64);b.putShort(58,(short)64);b.putShort(60,(short)3);
  int header=128;b.putInt(header+4,6);b.putLong(header+24,256);b.putLong(header+32,(names.length+1)*16);b.putInt(header+40,2);b.putLong(header+56,16);
  int used=0;for(int i=0;i<names.length;i++){byte[] name=names[i].getBytes(StandardCharsets.UTF_8);b.putLong(256+i*16,1);b.putLong(264+i*16,used);System.arraycopy(name,0,bytes,strings+used,name.length);used+=name.length+1;}
  b.putInt(192+4,3);b.putLong(192+24,strings);b.putLong(192+32,used);return bytes;
 }
 static void rejected(Path file,byte[] bytes)throws Exception{Files.write(file,bytes);try{ElfNativeExports.readMetadata(file);throw new AssertionError("Invalid metadata accepted");}catch(IOException expected){checks++;}}
 public static void main(String[] args)throws Exception{
  Path directory=Files.createTempDirectory("android-native-metadata-"),file=directory.resolve("libmain.so");try{
   Files.write(file,elf("libogg.so","libvorbis.so"));var metadata=ElfNativeExports.readMetadata(file);check(metadata.exports().isEmpty());check(metadata.dependencies().equals(List.of("libogg.so","libvorbis.so")));
   for(String name:new String[]{"../outside.so","dir/library.so","dir\\library.so",".","..",""})rejected(file,elf(name));
   byte[] bytes=elf("libdep.so");ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).putLong(128+24,Long.MAX_VALUE);rejected(file,bytes);
   bytes=elf("libdep.so");ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).putInt(128+40,3);rejected(file,bytes);
   bytes=elf("libdep.so");ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).putLong(264,Long.MAX_VALUE);rejected(file,bytes);
   bytes=elf("libdep.so");ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).putLong(272,1);rejected(file,bytes);
   bytes=elf("libdep.so");ByteBuffer b=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);b.putLong(192+32,9);bytes[528+9-1]='x';rejected(file,bytes);
   String[] many=new String[257];Arrays.fill(many,"liba.so");rejected(file,elf(many));
   Files.write(file,elf());check(ElfNativeExports.readMetadata(file).dependencies().isEmpty());
   System.out.println("PASS "+checks+" dependency metadata checks: bounded original DT_NEEDED, path/offset/termination/count failures");
  }finally{Files.deleteIfExists(file);Files.delete(directory);}
 }
}
