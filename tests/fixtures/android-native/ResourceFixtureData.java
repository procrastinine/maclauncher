package android.content.res;
import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
/** Generates owned compiled resource bytes; it does not parse or emulate resources. */
public final class ResourceFixtureData {
 static ByteBuffer buffer(int size){return ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN);}
 static byte[] chunk(int type,int header,byte[] body){var out=buffer(8+body.length);out.putShort((short)type).putShort((short)header).putInt(out.capacity()).put(body);return out.array();}
 static byte[] join(byte[]... parts){var out=new ByteArrayOutputStream();for(var part:parts)out.writeBytes(part);return out.toByteArray();}
 static byte[] pool(boolean utf8,String... values){var bytes=new ByteArrayOutputStream();var offsets=buffer(values.length*4);for(String value:values){offsets.putInt(bytes.size());byte[] data=value.getBytes(utf8?StandardCharsets.UTF_8:StandardCharsets.UTF_16LE);if(value.length()>127||data.length>127)throw new AssertionError();if(utf8){bytes.write(value.length());bytes.write(data.length);}else{bytes.write(value.length());bytes.write(0);}bytes.writeBytes(data);bytes.write(0);if(!utf8)bytes.write(0);}while(bytes.size()%4!=0)bytes.write(0);var metadata=buffer(20);metadata.putInt(values.length).putInt(0).putInt(utf8?256:0).putInt(28+values.length*4).putInt(0);return chunk(1,28,join(metadata.array(),offsets.array(),bytes.toByteArray()));}
 record Variant(String language,String region,int sdk,int qualifier,int type,int value,int layout){}
 static void locale(byte[] bytes,int offset,String part,int base){if(part.isEmpty())return;if(part.length()==2){bytes[offset]=(byte)part.charAt(0);bytes[offset+1]=(byte)part.charAt(1);}else if(part.length()==3){int a=part.charAt(0)-base,b=part.charAt(1)-base,c=part.charAt(2)-base;bytes[offset]=(byte)(128|(c<<2)|(b>>3));bytes[offset+1]=(byte)((b<<5)|a);}else throw new AssertionError();}
 static byte[] type(Variant value){byte[] config=new byte[28];var cb=ByteBuffer.wrap(config).order(ByteOrder.LITTLE_ENDIAN);cb.putInt(0,28);locale(config,8,value.language,'a');locale(config,10,value.region,'0');cb.putShort(24,(short)value.sdk);config[12]=(byte)value.qualifier;
  int flags=value.layout==1?1:value.layout==2?2:0;int indexBytes=flags==2?4:4;
  var header=buffer(40);header.put((byte)1).put((byte)flags).putShort((short)0).putInt(1).putInt(48+indexBytes).put(config);
  var offsets=buffer(indexBytes);offsets.putInt(0);
  var entry=buffer(value.layout==3?8:16);if(value.layout==3)entry.putShort((short)0).putShort((short)(8|(value.type<<8))).putInt(value.value);else entry.putShort((short)8).putShort((short)0).putInt(0).putShort((short)8).put((byte)0).put((byte)value.type).putInt(value.value);
  return chunk(0x201,48,join(header.array(),offsets.array(),entry.array()));
 }
 static byte[] table(boolean utf8,List<Variant> variants,String... values){byte[] types=pool(true,"string"),keys=pool(true,"message");var packageBody=buffer(280);packageBody.putInt(127);packageBody.putInt(260,288);packageBody.putInt(268,288+types.length);var children=new ByteArrayOutputStream();children.writeBytes(types);children.writeBytes(keys);children.writeBytes(chunk(0x202,16,buffer(12).put((byte)1).put((byte)0).putShort((short)0).putInt(1).putInt(0).array()));for(var value:variants)children.writeBytes(type(value));byte[] pkg=chunk(0x200,288,join(packageBody.array(),children.toByteArray()));return chunk(2,12,join(buffer(4).putInt(1).array(),pool(utf8,values),pkg));}
 static byte[] referenceTable(){byte[] types=pool(true,"string","reference"),keys=pool(true,"message");var packageBody=buffer(280);packageBody.putInt(127);packageBody.putInt(260,288);packageBody.putInt(268,288+types.length);byte[] first=type(new Variant("","",0,0,1,0x7f020000,0)),second=type(new Variant("","",0,0,3,0,0));second[8]=2;byte[] pkg=chunk(0x200,288,join(packageBody.array(),types,keys,first,second));return chunk(2,12,join(buffer(4).putInt(1).array(),pool(true,"resolved reference"),pkg));}
 static Variant value(String language,String region,int sdk,int qualifier,int index){return new Variant(language,region,sdk,qualifier,3,index,0);}
 static void check(boolean ok){if(!ok)throw new AssertionError();}
 interface Attempt{void run()throws Exception;}
 static void fails(Attempt action,Class<? extends Throwable> type)throws Exception{try{action.run();throw new AssertionError("Expected "+type);}catch(Throwable error){if(!type.isInstance(error))throw error;}}
}
