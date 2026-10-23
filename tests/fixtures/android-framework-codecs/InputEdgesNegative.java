import android.util.*;import java.io.*;
public final class InputEdgesNegative {public static void main(String[]args)throws Exception{
 if(args[0].equals("zero")){var in=new Base64InputStream(new ByteArrayInputStream(new byte[0]),0);if(in.read(new byte[0],0,0)!=0)throw new AssertionError("zero read reported EOF");}
 else if(args[0].equals("skip")){var in=new Base64InputStream(new ByteArrayInputStream("Zm9v".getBytes()),0);if(in.skip(-1)!=0||in.read()!='f')throw new AssertionError("negative skip changed the decoded cursor");}
 else {var out=new Base64OutputStream(OutputStream.nullOutputStream(),0);try{out.write(new byte[1],0,-1);throw new AssertionError("negative write accepted");}catch(IndexOutOfBoundsException expected){}}
}}
