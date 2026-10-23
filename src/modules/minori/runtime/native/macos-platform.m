#import <AppKit/AppKit.h>
#include <stdint.h>
#include <string.h>
@interface MLMinoriMenuTarget : NSObject
@property NSInteger selected;
- (void)choose:(id)sender;
@end
@implementation MLMinoriMenuTarget
- (void)choose:(id)sender { self.selected = [sender tag]; }
@end
int32_t ml_minori_context_menu(uint32_t flags) {
    @autoreleasepool {
        if (![NSThread isMainThread]) return 0;
        NSWindow *window = NSApp.keyWindow ?: NSApp.mainWindow;
        if (!window) return 0;
        MLMinoriMenuTarget *target = [MLMinoriMenuTarget new];
        NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Game"];
        const char *labels[] = {"Return to title", "Hide message panel", "Auto", "Skip", "Quick save", "Save", "Load", "Settings", "Full screen", "Windowed", "Help", "Website", "Quit"};
        for (NSInteger i=0;i<13;i++) {
            if (i==4 || i==8 || i==12) [menu addItem:[NSMenuItem separatorItem]];
            NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:[NSString stringWithUTF8String:labels[i]] action:@selector(choose:) keyEquivalent:@""];
            item.target=target; item.tag=i+1;
            if (i==1) { item.enabled=(flags&2)!=0; item.state=(flags&1)?NSControlStateValueOn:NSControlStateValueOff; }
            if (i==2) item.state=(flags&4)?NSControlStateValueOn:NSControlStateValueOff;
            if (i==3) item.state=(flags&8)?NSControlStateValueOn:NSControlStateValueOff;
            if (i>=4 && i<=6) item.enabled=(flags&16)!=0;
            if (i==8) item.state=(flags&32)?NSControlStateValueOn:NSControlStateValueOff;
            if (i==9) item.state=(flags&32)?NSControlStateValueOff:NSControlStateValueOn;
            [menu addItem:item];
        }
        menu.autoenablesItems=NO;
        NSPoint point=[window.contentView convertPoint:window.mouseLocationOutsideOfEventStream fromView:nil];
        [menu popUpMenuPositioningItem:nil atLocation:point inView:window.contentView];
        return (int32_t)target.selected;
    }
}
int32_t ml_minori_save_comment(const char *initial, uint32_t max_chars, char *output, uint32_t capacity) {
    @autoreleasepool {
        if (![NSThread isMainThread] || !initial || !output || capacity==0) return 0;
        NSAlert *alert=[NSAlert new]; alert.messageText=@"Save comment";
        NSTextField *field=[[NSTextField alloc] initWithFrame:NSMakeRect(0,0,380,26)];
        field.stringValue=[NSString stringWithUTF8String:initial] ?: @"";
        alert.accessoryView=field; [alert addButtonWithTitle:@"Save"]; [alert addButtonWithTitle:@"Cancel"];
        [alert.window makeFirstResponder:field];
        if ([alert runModal]!=NSAlertFirstButtonReturn) return 0;
        NSString *value=field.stringValue;
        if (value.length>max_chars) value=[value substringToIndex:max_chars];
        if (![value getCString:output maxLength:capacity encoding:NSUTF8StringEncoding]) return 0;
        return 1;
    }
}
int32_t ml_minori_open_url(const char *value) {
    @autoreleasepool {
        if (!value || ![NSThread isMainThread]) return 0;
        NSURL *url=[NSURL URLWithString:[NSString stringWithUTF8String:value]];
        if (!url || (![@"https" isEqualToString:url.scheme.lowercaseString] && ![@"http" isEqualToString:url.scheme.lowercaseString])) return 0;
        return [[NSWorkspace sharedWorkspace] openURL:url]?1:0;
    }
}
double ml_minori_double_click_interval(void) { return NSEvent.doubleClickInterval; }
