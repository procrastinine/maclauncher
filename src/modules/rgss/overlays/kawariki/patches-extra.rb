# Extra MKXP-Z patches cherry-picked from rpgmakermlinux-cicpoffs/mkxp-z/Kawariki-patches.

module Preload
    swap_chan = <<'RUBY'
def self.swap_chan(d, w)
    rs = w*4
    r = d.bytes.each_slice(rs).map { |rw| rw.pack('C*') }
    fd = r.reverse.join
    c = fd.unpack('C*').each_slice(4).to_a
    s = c.map { |r, g, b, a| [b, g, r, a] }
    s.flatten.pack('C*')
end
RUBY

    if defined?(Patches)
        Patches.reject! do |patch|
            patch.instance_variable_get(:@description) == "module ScreenShot"
        end
    end

    Patches << Patch.new("Advanced Text System fix")
        .include?("Advanced Text System")
        .include?("modern algebra (rmrk.net)")
        .replace!("Advanced-Text-System-.rb")

    Patches << Patch.new("rpgmaker vx window crash")
        .include?("class Window_Command < Window_Selectable")
        .include?("def initialize(width, commands, column_max = 1, row_max = 0, spacing = 32)")
        .sub!(
            "if row_max == 0",
            "  if commands.is_a?(Hash)\ncommands = commands.values\nend\nif row_max == 0"
        )

    Patches << Patch.new("CHANGED: F12 Crash fix")
        .if? { |script| script.name == "Super" }
        .if? { |script| script.context[:rgss_version] == 2 }
        .include?("# A N T I L A G    V X")
        .remove!

    Patches << Patch.new("CHANGED: Font fix")
        .if? { |script| script.name == "Main" }
        .if? { |script| script.context[:rgss_version] == 2 }
        .sub!(
            'Font.default_name = ["Source Han Sans K Normal"',
            'Font.default_name = ["Source Han Sans K"'
        )

    Patches << Patch.new("Changed-special: Spriteset_Map fix")
        .if? { |script| script.name == "Spriteset_Map" }
        .if? { |script| script.context[:rgss_version] == 2 }
        .include?("def update_parallax")
        .sub!(
            "@parallax.ox = $game_map.calc_parallax_x(@parallax.bitmap)",
            "begin; @parallax.ox = $game_map.calc_parallax_x(@parallax.bitmap)"
        )
        .sub!(
            "@parallax.oy = $game_map.calc_parallax_y(@parallax.bitmap)",
            "@parallax.oy = $game_map.calc_parallax_y(@parallax.bitmap); rescue; end"
        )

    Patches << Patch.new("CHANGED: Save bitmap fix")
        .if? { |script| script.name == "Save" }
        .if? { |script| script.context[:rgss_version] == 2 }
        .include?("RtlMoveMemory_pi = Win32API.new('kernel32', 'RtlMoveMemory', 'pii', 'i')")
        .include?("RtlMoveMemory_ip = Win32API.new('kernel32', 'RtlMoveMemory', 'ipi', 'i')")
        .sub!(
            "RtlMoveMemory_ip = Win32API.new('kernel32', 'RtlMoveMemory', 'ipi', 'i')",
            swap_chan
        )
        .sub!(
            "RtlMoveMemory_pi.call(data, address, data.length)",
            "data = Bitmap.swap_chan(self.raw_data, width)"
        )
        .sub!(
            "RtlMoveMemory_ip.call(b.address, Zlib::Inflate.inflate(zdata), w * h * 4)",
            "b.raw_data = self.swap_chan(Zlib::Inflate.inflate(zdata), w)"
        )

    Patches << Patch.new("module ScreenShot")
        .imported?(nil)
        .include?("module ScreenShot")
        .include?("http://d.hatena.ne.jp/ku-ma-me/20091003/p1")
        .remove!
end
