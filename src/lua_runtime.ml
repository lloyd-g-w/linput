(* Fengari implements Lua 5.3 locally. This module is the OCaml VM binding;
   scripts never receive JavaScript objects or browser APIs. *)
open Web

let engine = get global "Fengari"
let lua = get engine "lua"
let aux = get engine "lauxlib"
let libs = get engine "lualib"
let bytes s = call engine "to_luastring" [str s]
let invoke name args = call lua name args
let discard name args = ignore (invoke name args)
let constant name : int = get lua name
let message state =
  let v = invoke "lua_tojsstring" [state; num (-1)] in
  if defined v then text v else "Lua error (non-string error value)"
let close state = discard "lua_close" [state]
let compile state script =
  let source = bytes script in
  let result : int = call aux "luaL_loadbufferx"
    [state; source; get source "length"; bytes "@workflow.lua"; bytes "t"] in
  if result <> constant "LUA_OK" then invalid_arg (message state)
let check script =
  let state = call aux "luaL_newstate" [] in
  Fun.protect ~finally:(fun () -> close state) (fun () -> compile state script)

let bootstrap = {|local yield = coroutine.yield
local assert, type = assert, type
local function text(v, limit)
  assert(type(v) == "string", "expected a string")
  assert(#v <= limit, "string argument is too large")
  return v
end
local function selector(v)
  text(v, 1000)
  assert(#v > 0, "selector cannot be empty")
  return v
end
linput = {}
function linput.type(v) return yield("type", text(v, 100000)) end
function linput.enter() return yield("enter") end
function linput.tab() return yield("tab") end
function linput.submit() return yield("submit") end
function linput.click(v) return yield("click", selector(v)) end
function linput.focus(v) return yield("focus", selector(v)) end
function linput.exists(v) return yield("exists", selector(v)) end
function linput.value() return yield("value") end
function linput.log(v) return yield("log", text(v, 1000)) end
function linput.delay(ms)
  assert(type(ms) == "number" and ms == ms and ms >= 0 and ms <= 60000 and ms % 1 == 0,
    "delay must be an integer from 0 to 60000 ms")
  return yield("delay", ms)
end
function linput.split(v)
  text(v, 100000)
  local result = {}
  for word in v:gmatch("%S+") do result[#result + 1] = word end
  return result
end
-- No interpreter loading, JavaScript bridge, process, files, networking,
-- debugger or public coroutines (which could bypass the scheduler's hook).
coroutine, dofile, loadfile, load, collectgarbage, print = nil, nil, nil, nil, nil, nil
-- string.format uses a dependency with an unbounded-precision DoS advisory.
-- It is deliberately unavailable; concatenation/tostring remain available.
string.format, string.dump = nil, nil
local rep = string.rep
function string.rep(s, n, sep)
  text(s, 100000)
  assert(type(n) == "number" and n >= 0 and n <= 100000 and n % 1 == 0, "invalid repetition count")
  sep = sep or ""
  text(sep, 100000)
  assert(#s * n + #sep * math.max(0, n - 1) <= 100000, "repeated string is too large")
  return rep(s, n, sep)
end
|}

type argument = Nothing | Text of string | Number of float | Boolean of bool
type result = Finished | Slice | Action of string * argument | Failed of string
type t = { main : Js_of_ocaml.Js.Unsafe.any; thread : Js_of_ocaml.Js.Unsafe.any;
           mutable slices : int; mutable closed : bool }
let dispose vm = if not vm.closed then (vm.closed <- true; close vm.main)
let create script =
  let main = call aux "luaL_newstate" [] in
  try
    List.iter (fun (name, opener) ->
      ignore (call aux "luaL_requiref" [main; bytes name; get libs opener; num 1]);
      discard "lua_pop" [main; num 1])
      ["_G", "luaopen_base"; "table", "luaopen_table"; "string", "luaopen_string";
       "math", "luaopen_math"; "utf8", "luaopen_utf8"; "coroutine", "luaopen_coroutine"];
    compile main bootstrap;
    let result : int = invoke "lua_pcall" [main; num 0; num 0; num 0] in
    if result <> constant "LUA_OK" then invalid_arg (message main);
    let thread = invoke "lua_newthread" [main] in
    compile thread script;
    let vm = {main; thread; slices = 0; closed = false} in
    discard "lua_sethook" [thread; fn (fun state _ ->
      vm.slices <- vm.slices + 1;
      discard "lua_yield" [state; num 0]); num (constant "LUA_MASKCOUNT"); num 10000];
    vm
  with e -> close main; raise e

let push thread = function
  | Nothing -> discard "lua_pushnil" [thread]
  | Text s -> discard "lua_pushstring" [thread; bytes s]
  | Number n -> discard "lua_pushnumber" [thread; Js_of_ocaml.Js.Unsafe.inject n]
  | Boolean b -> discard "lua_pushboolean" [thread; bool b]
let argument thread index =
  let kind : int = invoke "lua_type" [thread; num index] in
  if kind = constant "LUA_TNIL" || kind = constant "LUA_TNONE" then Nothing
  else if kind = constant "LUA_TSTRING" then Text (text (invoke "lua_tojsstring" [thread; num index]))
  else if kind = constant "LUA_TNUMBER" then Number (invoke "lua_tonumber" [thread; num index])
  else invalid_arg "Unsupported Lua API argument"
let resume vm response =
  if vm.closed then Failed "Lua run is closed"
  else if vm.slices >= 500 then Failed "Lua instruction limit exceeded (5 million instructions)"
  else begin
    let nargs = match response with None -> 0 | Some v -> push vm.thread v; 1 in
    let result : int = invoke "lua_resume" [vm.thread; null; num nargs] in
    if result = constant "LUA_OK" then Finished
    else if result <> constant "LUA_YIELD" then Failed (message vm.thread)
    else begin
      let count : int = invoke "lua_gettop" [vm.thread] in
      if count = 0 then Slice
      else begin
        let op = match argument vm.thread 1 with Text s -> s | _ -> invalid_arg "Invalid Lua API operation" in
        let arg = argument vm.thread 2 in
        discard "lua_settop" [vm.thread; num 0];
        Action (op, arg)
      end
    end
  end
