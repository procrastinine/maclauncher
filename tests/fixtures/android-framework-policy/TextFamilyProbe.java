import android.text.*;
public final class TextFamilyProbe {
 public static void main(String[] args) {
  System.load(args[0]);System.load(args[1]);
  var text=new SpannableStringBuilder("one two");Object marker=new Object();text.setSpan(marker,4,7,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);Selection.setSelection(text,3);
  text.replace(0,3,"first");if(!text.toString().equals("first two")||text.getSpanStart(marker)!=6||text.getSpanEnd(marker)!=9||Selection.getSelectionStart(text)!=5)throw new AssertionError("Span mutation");
  var immutable=new SpannedString(text);if(!TextUtils.equals(immutable,text)||immutable.getSpanStart(marker)!=6)throw new AssertionError("Spans copy");
  String encoded=TextUtils.htmlEncode("<x>&\"");if(!encoded.equals("&lt;x&gt;&amp;&quot;"))throw new AssertionError(encoded);
  var filter=new InputFilter.LengthFilter(3);if(!filter.filter("abcdef",0,6,new SpannedString(""),0,0).toString().equals("abc"))throw new AssertionError("Filter");
  System.out.println("PASS raw AOSP span mutation, selection, immutable copies, text encoding and filters");
 }
}
