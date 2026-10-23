#import <AppKit/AppKit.h>
#include <jni.h>
#include <dlfcn.h>
#include <SDL3/SDL.h>
#include "../../../src/modules/android/native/input-key.h"
extern "C" JNIEXPORT void JNICALL Java_maclauncher_android_WebKitProbe_pumpNative(JNIEnv*env,jclass){
    @autoreleasepool { [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.002]];
        static auto pump=reinterpret_cast<int(*)(JNIEnv*)>(dlsym(RTLD_DEFAULT,"klj_session_pump"));
        if(!pump){jclass error=env->FindClass("java/lang/AssertionError");env->ThrowNew(error,"Actual session frame pump is unavailable");env->DeleteLocalRef(error);return;}pump(env);
    }
}
static void inspect(NSView*view,int depth){NSPoint point=NSMakePoint(50,view.isFlipped?40:view.bounds.size.height-40);NSView*target=[view hitTest:[view convertPoint:point toView:view.superview]];fprintf(stderr,"native view %d %s frame=%s flipped=%d hit=%s\n",depth,NSStringFromClass(view.class).UTF8String,NSStringFromRect(view.frame).UTF8String,view.isFlipped,target?NSStringFromClass(target.class).UTF8String:"nil");fprintf(stderr,"TEXT_CLIENT %s insert=%d mark=%d legacyMark=%d\n",NSStringFromClass(view.class).UTF8String,[view respondsToSelector:@selector(insertText:replacementRange:)],[view respondsToSelector:@selector(setMarkedText:selectedRange:replacementRange:)],[view respondsToSelector:@selector(setMarkedText:selectedRange:)]);for(NSView*child in view.subviews)inspect(child,depth+1);}
extern "C" JNIEXPORT void JNICALL Java_maclauncher_android_WebKitProbe_inspectNative(JNIEnv*env,jclass){for(NSWindow*window in NSApp.windows){NSView*root=window.contentView;fprintf(stderr,"FOCUS native responder=%s key=%d appActive=%d visible=%d occlusion=%lu hidden=%d\n",NSStringFromClass(window.firstResponder.class).UTF8String,window.keyWindow,NSApp.active,window.visible,(unsigned long)window.occlusionState,root.hiddenOrHasHiddenAncestor);inspect(root,0);NSView*target=[root hitTest:NSMakePoint(50,root.bounds.size.height-40)];if(target!=root){jclass error=env->FindClass("java/lang/AssertionError");env->ThrowNew(error,"Embedded browser intercepted the native SDL input target");env->DeleteLocalRef(error);return;}if([window.firstResponder isKindOfClass:NSView.class]&&![(NSView*)window.firstResponder isDescendantOf:root]){jclass error=env->FindClass("java/lang/AssertionError");env->ThrowNew(error,"Keyboard responder escaped the owned Android window");env->DeleteLocalRef(error);return;}}}

extern "C" JNIEXPORT void JNICALL Java_maclauncher_android_WebKitProbe_activateNative(JNIEnv*env,jclass){for(NSWindow*window in NSApp.windows)if([NSStringFromClass(window.contentView.class) hasPrefix:@"SDL3"]){[NSApp activateIgnoringOtherApps:YES];[window makeKeyAndOrderFront:nil];return;}jclass error=env->FindClass("java/lang/AssertionError");env->ThrowNew(error,"Owned SDL window is unavailable");env->DeleteLocalRef(error);}

// Inspect actual native focus without activating, ordering or changing a window.
extern "C" JNIEXPORT jboolean JNICALL Java_maclauncher_android_WebKitProbe_focusWindowNative(JNIEnv*env,jclass){for(NSWindow*window in NSApp.windows)if([NSStringFromClass(window.contentView.class)hasPrefix:@"SDL3"]){if(![NSStringFromClass(window.firstResponder.class)isEqualToString:@"MLAndroidWebView"]){auto error=env->FindClass("java/lang/AssertionError");env->ThrowNew(error,"Focused Android WebView does not own the native responder");env->DeleteLocalRef(error);}return window.keyWindow;}auto error=env->FindClass("java/lang/AssertionError");env->ThrowNew(error,"Owned Android window is unavailable");env->DeleteLocalRef(error);return false;}

extern "C" JNIEXPORT jboolean JNICALL Java_maclauncher_android_WebKitProbe_textNative(JNIEnv*e,jclass,jint kind,jstring value){
 auto content=reinterpret_cast<void*(*)(JNIEnv*)>(dlsym(RTLD_DEFAULT,"klj_session_native_content"));auto route=reinterpret_cast<int(*)(JNIEnv*,const SDL_Event*)>(dlsym(RTLD_DEFAULT,"klj_session_text_event"));
 if(!content||!route)return false;NSView*view=(__bridge NSView*)content(e);int count=0;SDL_Window**windows=SDL_GetWindows(&count);SDL_Window*window=nullptr;for(int i=0;i<count;i++)if(SDL_GetPointerProperty(SDL_GetWindowProperties(windows[i]),SDL_PROP_WINDOW_COCOA_WINDOW_POINTER,nullptr)==(__bridge void*)view.window){window=windows[i];break;}SDL_free(windows);if(!window)return false;SDL_Event event{};const jchar*chars=e->GetStringChars(value,nullptr);if(!chars)return false;NSString*valueString=[[NSString alloc]initWithCharacters:chars length:e->GetStringLength(value)];e->ReleaseStringChars(value,chars);const char*text=valueString.UTF8String;
 if(kind==0){event.type=SDL_EVENT_KEY_DOWN;event.key.windowID=SDL_GetWindowID(window);event.key.key=SDLK_A;event.key.scancode=SDL_SCANCODE_A;}
 else if(kind==1){event.type=SDL_EVENT_TEXT_INPUT;event.text.windowID=SDL_GetWindowID(window);event.text.text=text;}
 else{event.type=SDL_EVENT_TEXT_EDITING;event.edit.windowID=SDL_GetWindowID(window);event.edit.text=text;event.edit.start=0;event.edit.length=0;}
 int result=route(e,&event);return result;
}

// Inject only into this process's real NSApplication event path. No global
// events, accessibility permission, activation, or physical-key spoofing.
extern "C" JNIEXPORT jint JNICALL Java_maclauncher_android_WebKitProbe_physicalNative(JNIEnv*e,jclass,jint key,jstring text,jboolean command){
 auto content=reinterpret_cast<void*(*)(JNIEnv*)>(dlsym(RTLD_DEFAULT,"klj_session_native_content"));auto route=reinterpret_cast<int(*)(JNIEnv*,const SDL_Event*)>(dlsym(RTLD_DEFAULT,"klj_session_text_event"));
 NSView*view=(__bridge NSView*)content(e);NSWindow*window=view.window;const jchar*chars=e->GetStringChars(text,nullptr);NSString*value=[[NSString alloc]initWithCharacters:chars length:e->GetStringLength(text)];e->ReleaseStringChars(text,chars);
 // Give SDL's original window listener a test-local focus notification. This
 // changes its input routing only, never macOS focus or ordering.
 if([window.delegate respondsToSelector:@selector(windowDidBecomeKey:)])[window.delegate windowDidBecomeKey:[NSNotification notificationWithName:NSWindowDidBecomeKeyNotification object:window]];
 SDL_Event discard;while(SDL_PollEvent(&discard)){}
 fprintf(stderr,"PHYSICAL begin app=%s focus=%u window=%ld\n",NSStringFromClass(NSApp.class).UTF8String,SDL_GetWindowID(SDL_GetKeyboardFocus()),(long)window.windowNumber);
 if(command)[NSApp sendEvent:[NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:NSEventModifierFlagCommand timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:55]];
 for(int action=0;action<2;action++)[NSApp sendEvent:[NSEvent keyEventWithType:action?NSEventTypeKeyUp:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:command?NSEventModifierFlagCommand:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil characters:value charactersIgnoringModifiers:value isARepeat:NO keyCode:key]];
 if(command)[NSApp sendEvent:[NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:55]];
 int count=0;SDL_Event event;while(SDL_PollEvent(&event)){
  if(event.type!=SDL_EVENT_KEY_DOWN&&event.type!=SDL_EVENT_KEY_UP&&event.type!=SDL_EVENT_TEXT_INPUT&&event.type!=SDL_EVENT_TEXT_EDITING)continue;
  fprintf(stderr,"PHYSICAL event=%u key=%u mods=%u window=%u app=%s\n",event.type,event.key.key,event.key.mod,event.key.windowID,NSStringFromClass(NSApp.class).UTF8String);count++;
  if(route(e,&event))continue;
  if(event.type==SDL_EVENT_KEY_DOWN||event.type==SDL_EVENT_KEY_UP){int code=klj_android_keycode(event.key.key);if(!code)continue;jclass cls=e->FindClass("maclauncher/android/WebKitProbe");auto method=e->GetStaticMethodID(cls,"physicalKey","(IIII)V");e->CallStaticVoidMethod(cls,method,event.type==SDL_EVENT_KEY_DOWN?0:1,code,event.key.key>=32&&event.key.key<127?event.key.key:0,klj_android_keymeta(event.key.mod));e->DeleteLocalRef(cls);}
 }
 return count;
}
