#include "window-input.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
_Static_assert(sizeof(KLWindowInput)==32,"original physical IPC record");
static int enabled,starts,stops,clears;
static int pointWidth=800,pointHeight=600;
bool SDL_TextInputActive(SDL_Window *window){assert(window);return enabled;}
bool SDL_StartTextInput(SDL_Window *window){assert(window);enabled=1;starts++;return true;}
bool SDL_StopTextInput(SDL_Window *window){assert(window);enabled=0;stops++;return true;}
bool SDL_SetTextInputArea(SDL_Window *window,const SDL_Rect *area,int cursor){assert(window&&!area&&!cursor);clears++;return true;}
bool SDL_GetWindowSize(SDL_Window *window,int *width,int *height){assert(window);*width=pointWidth;*height=pointHeight;return true;}
int main(void){
 SDL_Window *window=(SDL_Window *)(uintptr_t)1;KLWindowEvent output;SDL_Event event={0};
 kl_window_input_text_mode(window,1);kl_window_input_text_mode(window,1);assert(starts==1&&enabled);
 kl_window_input_text_mode(window,0);kl_window_input_text_mode(window,0);assert(stops==1&&!enabled&&clears==2);
 event.key.type=SDL_EVENT_KEY_DOWN;event.key.windowID=7;event.key.key=SDLK_V;event.key.mod=SDL_KMOD_GUI;
 kl_window_input_decode(&event,7,1,&output);assert(output.value.kind==KL_INPUT_SHORTCUT&&output.value.code==50);
 event.key.repeat=true;kl_window_input_decode(&event,7,1,&output);assert(output.value.kind==KL_INPUT_CONSUMED);
 event.key.type=SDL_EVENT_KEY_UP;event.key.repeat=false;kl_window_input_decode(&event,7,1,&output);assert(output.value.kind==KL_INPUT_CONSUMED);
 event.key.type=SDL_EVENT_KEY_DOWN;kl_window_input_decode(&event,7,0,&output);assert(output.value.kind==KL_INPUT_KEY&&output.value.code==50&&output.value.meta==0x10000);
 event.key.key=SDLK_A;event.key.mod=0;kl_window_input_decode(&event,7,1,&output);assert(output.value.kind==KL_INPUT_CONSUMED);
 event.key.key=SDLK_BACKSPACE;kl_window_input_decode(&event,7,1,&output);assert(output.value.kind==KL_INPUT_KEY&&output.value.code==67);
 event.key.key=SDLK_DELETE;kl_window_input_decode(&event,7,1,&output);assert(output.value.kind==KL_INPUT_KEY&&output.value.code==112);
 event.key.key=SDLK_LEFT;kl_window_input_decode(&event,7,1,&output);assert(output.value.kind==KL_INPUT_KEY&&output.value.code==21);
 event.key.key=SDLK_F;event.key.mod=SDL_KMOD_CTRL|SDL_KMOD_GUI;kl_window_input_decode(&event,7,1,&output);assert(output.value.kind==KL_INPUT_KEY&&output.value.meta==0x11000);
 kl_window_input_decode(&event,8,1,&output);assert(output.value.kind==KL_INPUT_NONE);
 event=(SDL_Event){0};event.edit.type=SDL_EVENT_TEXT_EDITING;event.edit.windowID=7;event.edit.text="a\360\237\230\200";event.edit.start=1;event.edit.length=1;
 kl_window_input_decode(&event,7,1,&output);assert(output.value.kind==KL_INPUT_TEXT&&output.value.action==1&&output.start==1&&output.length==1&&!strcmp(output.text,"a\360\237\230\200"));
 event=(SDL_Event){0};event.text.type=SDL_EVENT_TEXT_INPUT;event.text.windowID=7;event.text.text="";
 kl_window_input_decode(&event,7,1,&output);assert(output.value.kind==KL_INPUT_TEXT&&!output.value.action&&output.text&&!output.text[0]);
 event=(SDL_Event){0};event.button.type=SDL_EVENT_MOUSE_BUTTON_DOWN;event.button.windowID=7;event.button.button=SDL_BUTTON_LEFT;event.button.x=100;event.button.y=150;
 kl_window_input_decode(&event,7,0,&output);assert(output.value.kind==KL_INPUT_TOUCH&&!output.value.action);
 assert(kl_window_input_coordinates(window,1600,1200,&output.value.x,&output.value.y)&&output.value.x==200&&output.value.y==300);
 // Physical points map once to the committed Android view, independently of
 // a game's smaller producer buffer. A screenshot's preview size is not input.
 pointWidth=1280;pointHeight=800;float x=640,y=588;
 assert(kl_window_input_coordinates(window,2560,1600,&x,&y)&&x==1280&&y==1176);
 x=640;y=588;assert(kl_window_input_coordinates(window,1280,800,&x,&y)&&x==640&&y==588);
 pointWidth=617;pointHeight=988;x=308.5f;y=494;
 assert(kl_window_input_coordinates(window,1234,1976,&x,&y)&&x==617&&y==988);
 pointWidth=800;pointHeight=600;
 event=(SDL_Event){0};event.motion.type=SDL_EVENT_MOUSE_MOTION;event.motion.windowID=7;event.motion.state=SDL_BUTTON_LMASK;event.motion.x=125;event.motion.y=175;
 kl_window_input_decode(&event,7,0,&output);assert(output.value.kind==KL_INPUT_TOUCH&&output.value.action==2&&output.value.x==125);
 event.motion.state=0;kl_window_input_decode(&event,7,0,&output);assert(output.value.kind==KL_INPUT_NONE);
 event=(SDL_Event){0};event.wheel.type=SDL_EVENT_MOUSE_WHEEL;event.wheel.windowID=7;event.wheel.mouse_x=123;event.wheel.mouse_y=321;event.wheel.x=-0.125f;event.wheel.y=0.375f;
 kl_window_input_decode(&event,7,0,&output);assert(output.value.kind==KL_INPUT_WHEEL&&output.value.dx==-0.125f&&output.value.dy==0.375f&&output.value.x==123&&output.value.y==321);
 event=(SDL_Event){0};event.window.type=SDL_EVENT_WINDOW_FOCUS_LOST;event.window.windowID=7;kl_window_input_decode(&event,7,0,&output);assert(output.value.kind==KL_INPUT_FOCUS&&!output.value.action);
 event.window.type=SDL_EVENT_WINDOW_CLOSE_REQUESTED;kl_window_input_decode(&event,7,0,&output);assert(output.value.kind==KL_INPUT_CLOSE);
 puts("PASS shared physical input: explicit shortcuts, IME, navigation, ownership, pointer geometry and fractional two-axis scroll");
}
