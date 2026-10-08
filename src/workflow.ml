type step = Type | Enter | Tab | Submit | Click of string | Delay of int

type t = { id : string; name : string; script : string }

let words text =
  String.split_on_char '\n' (String.map (function '\r' | '\t' | '\011' | '\012' | ' ' -> '\n' | c -> c) text)
  |> List.filter (fun s -> s <> "")

let parse_step text =
  let text = String.trim text in
  match text with
  | "type" -> Type | "enter" -> Enter | "tab" -> Tab | "submit" -> Submit
  | _ when String.starts_with ~prefix:"delay " text ->
    let n = try int_of_string (String.trim (String.sub text 6 (String.length text - 6)))
      with _ -> invalid_arg "Delay must be an integer in milliseconds" in
    if n < 0 || n > 60000 then invalid_arg "Delay must be between 0 and 60000 ms";
    Delay n
  | _ when String.starts_with ~prefix:"click " text ->
    let selector = String.trim (String.sub text 6 (String.length text - 6)) in
    if selector = "" then invalid_arg "Click requires a CSS selector";
    Click selector
  | _ -> invalid_arg ("Unknown step: " ^ text)

let parse_steps text =
  String.split_on_char '\n' text |> List.map String.trim
  |> List.filter (fun s -> s <> "") |> List.map parse_step

let string_of_step = function
  | Type -> "type" | Enter -> "enter" | Tab -> "tab" | Submit -> "submit"
  | Click s -> "click " ^ s | Delay n -> "delay " ^ string_of_int n

(* A quoted Lua string, not executable input. Three-digit escapes cannot eat a
   following digit. UTF-8 bytes are otherwise preserved verbatim. *)
let lua_quote text =
  let b = Buffer.create (String.length text + 2) in
  Buffer.add_char b '"';
  String.iter (function
    | '"' -> Buffer.add_string b "\\\""
    | '\\' -> Buffer.add_string b "\\\\"
    | '\n' -> Buffer.add_string b "\\n"
    | '\r' -> Buffer.add_string b "\\r"
    | '\t' -> Buffer.add_string b "\\t"
    | c when Char.code c < 32 || Char.code c = 127 ->
      Buffer.add_string b (Printf.sprintf "\\%03d" (Char.code c))
    | c -> Buffer.add_char b c) text;
  Buffer.add_char b '"'; Buffer.contents b

let lua_list items =
  "local items = {\n" ^ String.concat "" (List.map (fun s -> "  " ^ lua_quote s ^ ",\n") items) ^ "}\n"

let migrate items steps =
  lua_list items ^ "for _, item in ipairs(items) do\n" ^
  String.concat "" (List.map (fun step -> "  " ^ (match step with
    | Type -> "linput.type(item)" | Enter -> "linput.enter()"
    | Tab -> "linput.tab()" | Submit -> "linput.submit()"
    | Click selector -> "linput.click(" ^ lua_quote selector ^ ")"
    | Delay ms -> "linput.delay(" ^ string_of_int ms ^ ")") ^ "\n") steps) ^ "end\n"

let template = migrate ["apple"; "banana"] [Type; Enter; Delay 250]

let validate w =
  if w.id = "" || String.length w.id > 100 then invalid_arg "Invalid workflow ID";
  if String.trim w.name = "" || String.length w.name > 100 then invalid_arg "Name must be 1–100 bytes";
  if String.trim w.script = "" then invalid_arg "Add a Lua script";
  if String.length w.script > 20000 then invalid_arg "Lua script is too large"
