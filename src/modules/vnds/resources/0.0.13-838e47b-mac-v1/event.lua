local Event = require('lib/event')
local dispatch
dispatch = function(name, ...)
  Event.dispatch("event", name, ...)
  return Event.dispatch(name, ...)
end
local dispatch_often = Event.dispatch
local remove
remove = function(self)
  for _index_0 = 1, #self do
    local e = self[_index_0]
    Event.dispatch("event", "remove_handler", e.name)
    e:remove()
  end
end
local register
register = function(self)
  for _index_0 = 1, #self do
    local e = self[_index_0]
    Event.dispatch("event", "register_handler", e.name)
    e:register()
  end
end
return {
  dispatch = dispatch,
  dispatch_often = dispatch_often,
  on = Event.on,
  hook = Event.hook,
  remove = remove,
  register = register
}