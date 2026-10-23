import android.net.Uri;
import android.content.ComponentName;
import android.os.Parcel;
public class UriAdapterProbe {
 static void check(boolean value){if(!value)throw new AssertionError();}
 public static void main(String[] args)throws Exception{
  var loop=maclauncher.android.fixture.RuntimeFixture.initialize(args[0],args[1]);
  try{
  Uri source=Uri.parse("https://example.org/a%2Fb?q=first&q=two+words#frag");
  check(source.getPathSegments().equals(java.util.List.of("a/b")));
  check(source.getQueryParameters("q").equals(java.util.List.of("first","two+words")));
  Uri built=source.buildUpon().appendPath("é space").appendQueryParameter("a&b","c+d").fragment("x y").build();
  check(built.toString().equals("https://example.org/a%2Fb/%C3%A9%20space?q=first&q=two+words&a%26b=c%2Bd#x%20y"));
  check(source.toString().endsWith("#frag")&&built.getQueryParameter("a&b").equals("c+d"));
  check(Uri.parse("relative path").isRelative());
  check(Uri.parse("HTTP://example.org").normalizeScheme().getScheme().equals("http"));
  check(Uri.fromParts("mailto","a+b@example.org",null).isOpaque());
  check(Uri.decode("a%2Fb+%E9").equals("a/b+\ufffd"));
  check(new Uri.Builder().scheme("content").authority("app").appendPath("a/b").build().toString().equals("content://app/a%2Fb"));
  var parcel=Parcel.obtain();parcel.writeString8("é🙂");parcel.writeString8(null);built.writeToParcel(parcel,0);
  var component=ComponentName.createRelative("org.example",".Main");component.writeToParcel(parcel,0);
  parcel.setDataPosition(0);check(parcel.readString8().equals("é🙂")&&parcel.readString8()==null);
  check(Uri.CREATOR.createFromParcel(parcel).equals(built));
  check(ComponentName.CREATOR.createFromParcel(parcel).equals(component));check(parcel.dataAvail()==0);parcel.recycle();
  check(component.getShortClassName().equals(".Main")&&component.flattenToShortString().equals("org.example/.Main"));
  final int[] changed={0};
  var adapter=new android.widget.BaseAdapter(){public int getCount(){return 2;}public Object getItem(int p){return p;}public long getItemId(int p){return p;}public android.view.View getView(int p,android.view.View v,android.view.ViewGroup parent){return v;}};
  var observer=new android.database.DataSetObserver(){public void onChanged(){changed[0]++;adapter.unregisterDataSetObserver(this);}};
  adapter.registerDataSetObserver(observer);adapter.notifyDataSetChanged();adapter.notifyDataSetChanged();
  check(changed[0]==1&&!adapter.isEmpty()&&adapter.areAllItemsEnabled()&&adapter.isEnabled(1));
  }finally{maclauncher.android.framework.HostLooper.close(loop);}
  System.out.println("PASS upstream URI builders, encoded values, Parcelable identities and adapter observers");
 }
}
