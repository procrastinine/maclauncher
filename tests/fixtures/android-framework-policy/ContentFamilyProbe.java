import android.content.*;
import android.content.pm.*;
import android.net.Uri;
import android.os.PatternMatcher;

public final class ContentFamilyProbe {
 public static void main(String[] args)throws Exception {
  System.load(args[0]);System.load(args[1]);
  ComponentName component=ComponentName.createRelative("example.game",".Game");
  if(!ComponentName.unflattenFromString(component.flattenToString()).equals(component))throw new AssertionError("Component identity");
  Uri uri=new Uri.Builder().scheme("https").authority("example.invalid").appendPath("play now").appendQueryParameter("level","1 2").build();
  if(!uri.getPath().equals("/play now")||!uri.getQueryParameter("level").equals("1 2"))throw new AssertionError("URI encoding");
  Intent original=new Intent(Intent.ACTION_VIEW,uri).setComponent(component).putExtra("score",93).addCategory(Intent.CATEGORY_BROWSABLE);
  Intent copy=new Intent(original);copy.putExtra("score",24);
  if(original.getIntExtra("score",0)!=93||copy.getIntExtra("score",0)!=24||!copy.getComponent().equals(component))throw new AssertionError("Intent copy state");
  IntentFilter filter=new IntentFilter(Intent.ACTION_VIEW);
  filter.addCategory(Intent.CATEGORY_BROWSABLE);filter.addDataScheme("https");filter.addDataAuthority("example.invalid",null);filter.addDataPath("/play",PatternMatcher.PATTERN_PREFIX);
  if(filter.match(null,original,false,"ContentFamilyProbe")<0)throw new AssertionError("Authority/path filter");
  Intent other=new Intent(original).setData(Uri.parse("https://other.invalid/play"));
  if(filter.match(null,other,false,"ContentFamilyProbe")>=0)throw new AssertionError("Authority mismatch");
  ApplicationInfo app=new ApplicationInfo();app.packageName="example.game";app.theme=93;app.targetSdkVersion=36;
  ApplicationInfo appCopy=new ApplicationInfo(app);
  if(appCopy.theme!=93||!appCopy.packageName.equals(app.packageName)||appCopy.targetSdkVersion!=36)throw new AssertionError("Package state");
  ActivityInfo activity=new ActivityInfo();activity.applicationInfo=app;activity.theme=0;
  if(activity.getThemeResource()!=93)throw new AssertionError("Inherited application theme");
  ClipData clipboard=ClipData.newPlainText("label","first");clipboard.addItem(new ClipData.Item("second"));
  if(clipboard.getItemCount()!=2||!clipboard.getItemAt(1).getText().equals("second"))throw new AssertionError("Clipboard data");
  System.out.println("PASS raw AOSP intent copies, URI encoding, complete path filters, package metadata and clipboard data");
 }
}
