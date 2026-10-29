import android.util.*;import java.io.*;
public final class InputEdgesNegative {public static void main(String[]args)throws Exception{
 if(args[0].equals("zero")){var in=new Base64InputStream(new ByteArrayInputStream(new byte[0]),0);if(in.read(new byte[0],0,0)!=-1)throw new AssertionError("Original EOF precedes zero-length handling");}
 else if(args[0].equals("skip")){var in=new Base64InputStream(new ByteArrayInputStream("Zm9v".getBytes()),0);if(in.skip(-1)!=-1)throw new AssertionError("Original negative skip no longer follows its signed minimum");try{in.read();throw new AssertionError("Original negative cursor was silently repaired");}catch(ArrayIndexOutOfBoundsException expected){}}
 else {var sink=new ByteArrayOutputStream();var out=new Base64OutputStream(sink,0);out.write(new byte[1],0,-1);out.close();if(sink.size()!=0)throw new AssertionError("Original non-positive write produced bytes");}
}}
