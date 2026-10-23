import android.util.*;
import org.json.*;
public final class PortableFamilyProbe {
 public static void main(String[] args) throws Exception {
  SparseIntArray sparse=new SparseIntArray();sparse.put(91,3);sparse.append(200,8);sparse.delete(91);if(sparse.size()!=1||sparse.get(200)!=8)throw new AssertionError();
  ArrayMap<String,Integer> map=new ArrayMap<>();map.put("first",1);map.put("second",2);map.remove("first");if(map.size()!=1||map.get("second")!=2)throw new AssertionError();
  ArraySet<String> set=new ArraySet<>();set.add("a");set.add("a");if(set.size()!=1)throw new AssertionError();
  LruCache<String,Integer> cache=new LruCache<>(1);cache.put("a",1);cache.put("b",2);if(cache.get("a")!=null||cache.get("b")!=2)throw new AssertionError();
  String text="portable \u2603";if(!text.equals(new String(Base64.decode(Base64.encodeToString(text.getBytes("UTF-8"),Base64.NO_WRAP),Base64.DEFAULT),"UTF-8")))throw new AssertionError();
  JSONObject value=new JSONObject("{\"a\":[1,true,null],\"n\":3.25}");if(value.getJSONArray("a").getInt(0)!=1||!value.getJSONArray("a").getBoolean(1)||value.getDouble("n")!=3.25)throw new AssertionError();
  if(!new Range<Integer>(1,3).contains(2)||new Size(2,3).getHeight()!=3)throw new AssertionError();
  if(!org.xmlpull.v1.XmlPullParser.class.isInterface())throw new AssertionError();
  System.out.println("PASS raw AOSP collections, codecs, value types, JSON and XML interface");
 }
}
