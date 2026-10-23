import android.text.*;
import java.util.*;

public final class TextSpanProbe {
 static int checks;
 static void check(boolean value){checks++;if(!value)throw new AssertionError("check "+checks);}
 static void equal(Object a,Object b){check(Objects.equals(a,b));}
 static void rejects(Runnable action){try{action.run();throw new AssertionError("accepted invalid input");}catch(RuntimeException expected){checks++;}}
 public static void main(String[] args){
  var runtime=java.nio.file.Path.of(args[0]);System.setProperty("klepton.bridge",runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(System.getProperty("klepton.bridge"));System.load(runtime.resolve("native/libnativebinding.dylib").toString());
  maclauncher.android.framework.JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));maclauncher.android.framework.JvmNativeMemory.initialize();
  SpannableStringBuilder text=new SpannableStringBuilder("abcd");Object keep=new Object(),exclude=new Object();
  text.setSpan(keep,1,3,Spanned.SPAN_INCLUSIVE_INCLUSIVE);text.setSpan(exclude,1,3,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
  text.insert(1,"X");equal(text.toString(),"aXbcd");check(text.getSpanStart(keep)==1&&text.getSpanStart(exclude)==2);
  text.insert(4,"Y");check(text.getSpanEnd(keep)==5&&text.getSpanEnd(exclude)==4);
  text.delete(2,4);check(text.getSpanStart(exclude)==-1);check(text.getSpanStart(keep)==1&&text.getSpanEnd(keep)==3);
  rejects(()->text.setSpan(new Object(),-1,2,33));rejects(()->text.setSpan(new Object(),0,99,33));
  Object paragraph=new Object();var paragraphs=new SpannableStringBuilder("one\ntwo\n");paragraphs.setSpan(paragraph,0,4,Spanned.SPAN_PARAGRAPH);rejects(()->paragraphs.setSpan(new Object(),1,4,Spanned.SPAN_PARAGRAPH));
  paragraphs.delete(2,5);check(paragraphs.getSpanStart(paragraph)==0&&paragraphs.getSpanEnd(paragraph)==paragraphs.length());
  var ordered=new SpannableStringBuilder("abc");Object low=new Object(),high=new Object(),same=new Object();
  ordered.setSpan(low,0,2,17);ordered.setSpan(high,1,3,17|(4<<Spanned.SPAN_PRIORITY_SHIFT));ordered.setSpan(same,0,2,17);
  check(Arrays.equals(ordered.getSpans(0,3,Object.class),new Object[]{high,low,same}));check(ordered.nextSpanTransition(0,3,Object.class)==1);
  NoCopySpan noCopy=new NoCopySpan.Concrete();ordered.setSpan(noCopy,0,1,17);
  var slice=new SpannableStringBuilder(ordered,1,3);check(slice.getSpanStart(noCopy)==-1&&slice.getSpanStart(high)==0&&slice.getSpanEnd(high)==2);
  var immutable=new SpannedString(ordered);ordered.removeSpan(low);check(immutable.getSpanStart(low)==0);check(SpannedString.valueOf(immutable)==immutable);
  var mutable=new SpannableString(immutable);mutable.removeSpan(high);check(immutable.getSpanStart(high)==1&&mutable.getSpanStart(high)==-1);
  var selected=new SpannableStringBuilder("abcdef");Selection.setSelection(selected,2,4);selected.replace(0,6,"xyz");check(Selection.getSelectionStart(selected)==1&&Selection.getSelectionEnd(selected)==2);Selection.extendSelection(selected,3);check(Selection.getSelectionEnd(selected)==3);Selection.removeSelection(selected);check(Selection.getSelectionStart(selected)==-1);
  var filters=new SpannableStringBuilder();filters.setFilters(new InputFilter[]{new InputFilter.LengthFilter(3)});filters.append("a😀z");equal(filters.toString(),"a😀");filters.clear();filters.setFilters(new InputFilter[]{new InputFilter.LengthFilter(2)});filters.append("a😀");equal(filters.toString(),"a");
  InputFilter.AllCaps caps=new InputFilter.AllCaps(Locale.GERMAN);var source=new SpannableString("straße");Object style=new Object();source.setSpan(style,4,5,33);Spanned upper=(Spanned)caps.filter(source,0,source.length(),new SpannableString(""),0,0);equal(upper.toString(),"STRASSE");check(upper.getSpanStart(style)==4&&upper.getSpanEnd(style)==6);
  equal(new InputFilter.AllCaps(Locale.forLanguageTag("tr")).filter("i",0,1,filters,0,0).toString(),"İ");
  var lithuanian=new SpannableString("i\u0307");lithuanian.setSpan(style,0,2,33);equal(new InputFilter.AllCaps(Locale.forLanguageTag("lt")).filter(lithuanian,0,2,filters,0,0).toString(),"I");
  var callbacks=new ArrayList<String>();var watched=new SpannableStringBuilder("abc");TextWatcher watcher=new TextWatcher(){public void beforeTextChanged(CharSequence s,int p,int n,int a){callbacks.add("before:"+s);}public void onTextChanged(CharSequence s,int p,int n,int a){callbacks.add("on:"+s);}public void afterTextChanged(Editable s){callbacks.add("after:"+s);}};
  watched.setSpan(watcher,0,3,18);watched.replace(1,2,"XY");equal(callbacks,List.of("before:abc","on:aXYc","after:aXYc"));check(new SpannableStringBuilder(watched).getSpanStart(watcher)==-1);
  int[] spanEvents={0,0,0};SpanWatcher sw=new SpanWatcher(){public void onSpanAdded(Spannable s,Object w,int a,int b){spanEvents[0]++;}public void onSpanRemoved(Spannable s,Object w,int a,int b){spanEvents[1]++;}public void onSpanChanged(Spannable s,Object w,int a,int b,int c,int d){spanEvents[2]++;}};watched.setSpan(sw,0,watched.length(),18);Object moving=new Object();watched.setSpan(moving,1,2,33);watched.setSpan(moving,0,1,33);watched.removeSpan(moving);check(spanEvents[0]>=1&&spanEvents[1]==1&&spanEvents[2]==1);
  SpannableStringBuilder host=new SpannableStringBuilder("abcXYZ");int[] events={0};host.setSpan(new TextWatcher(){public void beforeTextChanged(CharSequence s,int p,int n,int a){events[0]++;check(p==3&&n==3&&a==2);}public void onTextChanged(CharSequence s,int p,int n,int a){}public void afterTextChanged(Editable s){}},0,host.length(),Spanned.SPAN_INCLUSIVE_INCLUSIVE);host.setFilters(new InputFilter[]{new InputFilter.LengthFilter(5)});host.replace(3,6,"deZZ");equal(host.toString(),"abcde");check(events[0]==1);
  SpannableStringBuilder reentrant=new SpannableStringBuilder("x");int[] recursive={0};reentrant.setSpan(new TextWatcher(){public void beforeTextChanged(CharSequence s,int p,int n,int a){}public void onTextChanged(CharSequence s,int p,int n,int a){}public void afterTextChanged(Editable s){if(recursive[0]++==0)s.append('!');}},0,reentrant.length(),Spanned.SPAN_INCLUSIVE_INCLUSIVE);reentrant.append('y');equal(reentrant.toString(),"xy!");check(recursive[0]==2);reentrant.clearSpans();reentrant.append('z');check(recursive[0]==2);
  Random random=new Random(231);var actual=new SpannableStringBuilder();var expected=new StringBuilder();for(int i=0;i<3000;i++){int a=random.nextInt(expected.length()+1),b=a+random.nextInt(expected.length()-a+1);String value="x"+i;actual.replace(a,b,value);expected.replace(a,b,value);equal(actual.toString(),expected.toString());}
  check(Editable.Factory.getInstance().newEditable("x") instanceof SpannableStringBuilder);check(Spannable.Factory.getInstance().newSpannable("x") instanceof SpannableString);
  System.out.println("PASS "+checks+" upstream spans, edits, filters, selection and widget listeners");
 }
}
