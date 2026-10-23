package maclauncher.android;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Owned one-string Android resource table. No downloaded or game bytes. */
final class SyntheticResources {
    static ByteBuffer buffer(int bytes) { return ByteBuffer.allocate(bytes).order(ByteOrder.LITTLE_ENDIAN); }
    static byte[] join(byte[]... parts) { var out=new ByteArrayOutputStream(); for(var part:parts)out.writeBytes(part); return out.toByteArray(); }
    static byte[] chunk(int type,int header,byte[] body) {
        return buffer(body.length+8).putShort((short)type).putShort((short)header).putInt(body.length+8).put(body).array();
    }
    static byte[] pool(String... values) {
        var data=new ByteArrayOutputStream();var offsets=buffer(values.length*4);
        for(String value:values){byte[] bytes=value.getBytes(StandardCharsets.UTF_8);
        if(bytes.length>127||value.length()>127)throw new AssertionError();
        offsets.putInt(data.size());data.write(value.length());data.write(bytes.length);data.writeBytes(bytes);data.write(0);}
        while(data.size()%4!=0)data.write(0);
        return chunk(1,28,join(buffer(20).putInt(values.length).putInt(0).putInt(256).putInt(28+values.length*4).putInt(0).array(),offsets.array(),data.toByteArray()));
    }
    static byte[] table(String language,String value) {
        return table(new String[]{language},new String[]{value});
    }
    static byte[] table(String[] languages,String[] values) {
        if(languages.length!=values.length)throw new AssertionError();var variants=new ByteArrayOutputStream();
        for(int index=0;index<languages.length;index++){String language=languages[index];
        var configuration=buffer(28).putInt(0,28);
        if(!language.isEmpty()){configuration.put(8,(byte)language.charAt(0));configuration.put(9,(byte)language.charAt(1));}
        variants.writeBytes(chunk(0x201,48,join(buffer(40).put((byte)1).put((byte)0).putShort((short)0).putInt(1).putInt(52).put(configuration.array()).array(),buffer(4).putInt(0).array(),buffer(16).putShort((short)8).putShort((short)0).putInt(0).putShort((short)8).put((byte)0).put((byte)3).putInt(index).array())));}
        byte[] types=pool("string"),keys=pool("message");
        var pkg=buffer(280).putInt(0,127).putInt(260,288).putInt(268,288+types.length);
        return chunk(2,12,join(buffer(4).putInt(1).array(),pool(values),chunk(0x200,288,join(pkg.array(),types,keys,chunk(0x202,16,buffer(12).put((byte)1).put((byte)0).putShort((short)0).putInt(1).putInt(0).array()),variants.toByteArray()))));
    }
    static void locales(Path path,String[] languages,String[] values)throws Exception {
        try(var zip=new ZipOutputStream(Files.newOutputStream(path))){zip.putNextEntry(new ZipEntry("resources.arsc"));zip.write(table(languages,values));zip.closeEntry();}
    }
    static void apk(Path path,String language,String value,String extra)throws Exception {
        try(var zip=new ZipOutputStream(Files.newOutputStream(path))){
            zip.putNextEntry(new ZipEntry("resources.arsc"));zip.write(table(language,value));zip.closeEntry();
            if(extra!=null){zip.putNextEntry(new ZipEntry(extra));zip.write(new byte[]{1,2,3,4});zip.closeEntry();}
        }
    }
}
