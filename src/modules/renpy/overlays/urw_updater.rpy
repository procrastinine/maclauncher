# MacLauncher owns add-on updates so upstream self-updates cannot replace its
# compatibility/security corrections. This screen retains the upstream entry.
screen URW_updater_screen():
    tag menu
    modal True
    zorder 205
    key "game_menu" action Hide("URW_updater_screen")
    key "K_ESCAPE" action Hide("URW_updater_screen")
    frame:
        xalign 0.5
        yalign 0.5
        padding (30, 30)
        vbox:
            spacing 20
            text "Universal Ren'Py Walkthrough"
            text "This add-on is managed by MacLauncher. Update MacLauncher and reinstall the walkthrough from the launcher to update it." xmaximum 550
            textbutton "Close" action Hide("URW_updater_screen")
