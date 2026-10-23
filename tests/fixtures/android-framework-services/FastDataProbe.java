import java.io.*;
import java.util.*;
import android.util.Xml;
import com.android.internal.util.ArtFastDataInput;
import com.android.internal.util.ArtFastDataOutput;
import maclauncher.android.fixture.RuntimeFixture;

public final class FastDataProbe {
    public static void main(String[] args)throws Exception{
        RuntimeFixture.initialize(args[0],args[1]);
        for(Class<?> type:List.of(byte.class,boolean.class,char.class,short.class,int.class,long.class,float.class,double.class,String.class)){
            Object array=dalvik.system.VMRuntime.getRuntime().newNonMovableArray(type,9);
            if(array.getClass().getComponentType()!=type||java.lang.reflect.Array.getLength(array)!=9)throw new AssertionError("Array allocation ABI");
        }
        String[] values={"","ascii","nul\u0000value","日本語 café 🎮", "large 🎮 payload ".repeat(1200)};
        for(int capacity:new int[]{16,64,32768}){
            var bytes=new ByteArrayOutputStream();var out=new ArtFastDataOutput(bytes,capacity);
            for(String value:values){out.writeUTF(value);out.writeInt(0x12345678);}out.flush();
            System.gc();
            var in=new ArtFastDataInput(new ByteArrayInputStream(bytes.toByteArray()),capacity);
            for(String value:values)if(!value.equals(in.readUTF())||in.readInt()!=0x12345678)throw new AssertionError("Original UTF buffering or following bytes changed");
        }
        var bytes=new ByteArrayOutputStream();var xml=Xml.newBinarySerializer();xml.setOutput(bytes,"UTF-8");
        xml.startDocument(null,true);xml.startTag(null,"entry");xml.attribute(null,"name",values[3]);xml.attributeInt(null,"count",42);
        xml.text(values[4]);xml.endTag(null,"entry");xml.endDocument();xml.flush();
        var parser=Xml.newBinaryPullParser();parser.setInput(new ByteArrayInputStream(bytes.toByteArray()),"UTF-8");parser.nextTag();
        if(!values[3].equals(parser.getAttributeValue(null,"name"))||parser.getAttributeInt(null,"count")!=42||!values[4].equals(parser.nextText()))throw new AssertionError("Original binary XML round trip");
        System.out.println("PASS original fast-data and binary XML codecs with scoped JNI arrays");
    }
}
