local helper = require("helper")

local function build(value)
  helper.run(value)
end

function App:start()
  build(1)
end
