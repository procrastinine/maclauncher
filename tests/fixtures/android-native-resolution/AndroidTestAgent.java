package maclauncher.test;
import java.nio.*;
import java.nio.charset.StandardCharsets;
public final class AndroidTestAgent {
 private static native long[] fixturePointers();
 private static native byte[] readOwnMemory(long address,int length);
 private static native byte[] describeOwnAddresses(long[] addresses,String runtime);
 public static void main(String[] args){
  System.load(args[0]);long[] pointers=fixturePointers();
  long actual=ByteBuffer.wrap(readOwnMemory(pointers[0],8)).order(ByteOrder.LITTLE_ENDIAN).getLong();
  String owners=new String(describeOwnAddresses(new long[]{actual,pointers[1],0},args[0]),StandardCharsets.UTF_8);
  if(!owners.contains("puts")||!owners.contains("fixture-guest.so")||!owners.contains("\"imageOffset\":4660")||!owners.contains("\"pc\":\"0x0\""))throw new AssertionError(owners);
  boolean invalid=false;try{readOwnMemory(1,8);}catch(IllegalArgumentException expected){invalid=true;}
  if(!invalid)throw new AssertionError("Unreadable slot must fail without dereferencing it");
  System.out.println("PASS live own-task pointer slot, actual Mach-O/guest image owners, null and unreadable addresses");
 }
}
