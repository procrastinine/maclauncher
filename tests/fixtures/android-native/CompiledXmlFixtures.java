package android.content.res;
import java.io.*;
import java.nio.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

/** Generates owned binary XML and APK bytes for the native resource engine. */
public final class CompiledXmlFixtures {
 static int checks;
 static void check(boolean value){checks++;if(!value)throw new AssertionError();}
 interface Work {void run()throws Exception;}
 static void fails(Work work)throws Exception{checks++;try{work.run();}catch(IOException|Resources.NotFoundException expected){return;}throw new AssertionError("Expected malformed/unsupported resource failure");}
 static final String[] S={"android","http://schemas.android.com/apk/res/android","PreferenceScreen","key","defaultValue","persistent","SwitchPreference","ListPreference","SeekBarPreference","test_boolean","test_string","test_integer","CustomPreference","plain"};
 static byte[] node(int type,int bytes){ByteBuffer b=ByteBuffer.allocate(bytes).order(ByteOrder.LITTLE_ENDIAN);b.putShort(0,(short)type);b.putShort(2,(short)16);b.putInt(4,bytes);b.putInt(8,1);b.putInt(12,-1);return b.array();}
 static byte[] namespace(int type){byte[] bytes=node(type,24);ByteBuffer b=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);b.putInt(16,0);b.putInt(20,1);return bytes;}
 static byte[] end(int tag){byte[] bytes=node(0x103,24);ByteBuffer b=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);b.putInt(16,-1);b.putInt(20,tag);return bytes;}
 static byte[] start(int tag,int[]...attrs){byte[] bytes=node(0x102,36+20*attrs.length);ByteBuffer b=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);b.putInt(16,-1);b.putInt(20,tag);b.putShort(24,(short)20);b.putShort(26,(short)20);b.putShort(28,(short)attrs.length);for(int i=0;i<attrs.length;i++){int at=36+20*i;int[] a=attrs[i];b.putInt(at,1);b.putInt(at+4,a[0]);b.putInt(at+8,-1);b.putShort(at+12,(short)8);b.put(at+15,(byte)a[1]);b.putInt(at+16,a[2]);}return bytes;}
 static byte[] document(boolean utf8,byte[]...elements)throws Exception{ByteArrayOutputStream output=new ByteArrayOutputStream();output.write(new byte[8]);output.write(ResourceFixtureData.pool(utf8,S));var resourceMap=ByteBuffer.allocate(S.length*4).order(ByteOrder.LITTLE_ENDIAN);resourceMap.putInt(3*4,android.R.attr.key);resourceMap.putInt(4*4,android.R.attr.defaultValue);resourceMap.putInt(5*4,android.R.attr.persistent);output.write(ResourceFixtureData.chunk(0x180,8,resourceMap.array()));output.write(namespace(0x100));output.write(start(2));for(byte[] element:elements)output.write(element);output.write(end(2));output.write(namespace(0x101));byte[] bytes=output.toByteArray();ByteBuffer b=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);b.putShort(0,(short)3);b.putShort(2,(short)8);b.putInt(4,bytes.length);return bytes;}
 static int[] attr(int name,int type,int value){return new int[]{name,type,value};}
 static byte[] doc(boolean utf8)throws Exception{return document(utf8,start(6,attr(3,3,9),attr(4,1,0x7f020000)),end(6),start(7,attr(3,3,10),attr(4,0x10,7)),end(7),start(8,attr(3,3,11),attr(4,0x10,11)),end(8));}
 static Path apk(Path root,String name,String xmlPath,byte[] xml)throws Exception{
  Path file=root.resolve(name);try(ZipOutputStream out=new ZipOutputStream(Files.newOutputStream(file))){out.putNextEntry(new ZipEntry("resources.arsc"));out.write(ResourceFixtureData.table(true,List.of(ResourceFixtureData.value("","",0,0,0)),xmlPath));out.closeEntry();out.putNextEntry(new ZipEntry(xmlPath));out.write(xml);out.closeEntry();}return file;
 }
}
