#pragma once

namespace macfx {
// Owner-mutex protected. A driver may call back before present() returns.
// Both events must retire before a held transaction can acknowledge draining.
class PresentationTicket {
    bool reserved=false,returned=false,terminal=false,retired=false;
    bool retire(){if(!reserved||!returned||!terminal||retired)return false;retired=true;return true;}
public:
    bool reserve(){if(reserved||terminal)return false;reserved=true;return true;}
    bool callReturned(){returned=true;return retire();}
    bool completed(){terminal=true;return retire();}
};
}
