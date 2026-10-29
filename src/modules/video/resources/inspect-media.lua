local mp = require 'mp'
local utils = require 'mp.utils'
local exported = false
mp.add_hook('on_preloaded', 50, function()
    local output = os.getenv('MACLAUNCHER_MEDIA_INFO')
    local file = output and io.open(output, 'w')
    if not file then
        mp.msg.error('The media inspection output could not be written.')
        mp.commandv('quit', '1')
        return
    end
    local info = {
        format = mp.get_property('file-format'),
        duration = mp.get_property_number('duration'),
        metadata = mp.get_property_native('metadata'),
        tracks = mp.get_property_native('track-list'),
        chapters = mp.get_property_native('chapter-list'),
        video = mp.get_property_native('video-params'),
        audio = mp.get_property_native('audio-params')
    }
    file:write(utils.format_json(info))
    file:close()
    exported = true
    mp.commandv('quit', '0')
end)
mp.register_event('end-file', function()
    if not exported then mp.commandv('quit', '1') end
end)
