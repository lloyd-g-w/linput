open Js_of_ocaml
open Web

let target = ref null
let running = ref false
let generation = ref 0
let panel = ref null
let active_vm = ref None
let release_vm () =
  Option.iter Lua_runtime.dispose !active_vm;
  active_vm := None
let editable el =
  if not (defined el) || not (defined (get el "tagName")) then false else
  let tag = text (get el "tagName") in
  (tag = "TEXTAREA" || (tag = "INPUT" && List.mem (text (get el "type"))
    ["text"; "search"; "email"; "url"; "tel"; "password"; "number"]) || truth (get el "isContentEditable"))
  && not (truth (get el "disabled")) && not (truth (get el "readOnly"))
let rec editing_host el =
  let parent = get el "parentElement" in
  if defined parent && truth (get parent "isContentEditable") then editing_host parent else el
let rec ancestor el =
  if not (defined el) then null
  else if editable el then
    (if truth (get el "isContentEditable") then editing_host el else el)
  else ancestor (get el "parentElement")
let status message =
  if not (defined !panel) then begin
    let p = call document "createElement" [str "div"] in
    set (get p "style") "cssText" (str "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#182236;color:white;padding:14px 18px;border-radius:10px;font:14px system-ui;box-shadow:0 4px 24px #0006;cursor:pointer;max-width:440px");
    set p "role" (str "status");
    on p "click" (fun _ -> incr generation; running := false; release_vm (); ignore (call p "remove" []); panel := null);
    ignore (call (get document "documentElement") "appendChild" [p]); panel := p
  end;
  set !panel "textContent" (str message)
let stop () =
  incr generation;
  release_vm ();
  if !running then (running := false; status "linput stopped. Click to dismiss.")
let event el name options =
  let ctor = get global name in
  let ev = Js.Unsafe.new_obj ctor [|str (if name = "InputEvent" then "input" else "change"); options|] in
  ignore (call el "dispatchEvent" [ev])
let key el name key code =
  let ev = Js.Unsafe.new_obj (get global "KeyboardEvent")
    [|str name; obj ["key", str key; "code", str key; "keyCode", num code; "which", num code; "bubbles", bool true; "cancelable", bool true]|] in
  truth (call el "dispatchEvent" [ev])
let connected el = defined el && truth (get el "isConnected")
let type_item el item =
  if not (connected el && editable el) then invalid_arg "Target is no longer an editable field";
  ignore (call el "focus" []);
  let before = Js.Unsafe.new_obj (get global "InputEvent")
    [|str "beforeinput"; obj ["bubbles", bool true; "cancelable", bool true; "inputType", str "insertText"; "data", str item]|] in
  if not (truth (call el "dispatchEvent" [before])) then invalid_arg "Site cancelled typing";
  let tag = text (get el "tagName") in
  if tag = "INPUT" || tag = "TEXTAREA" then begin
    let proto = get (get global (if tag = "INPUT" then "HTMLInputElement" else "HTMLTextAreaElement")) "prototype" in
    let descriptor = call (get global "Object") "getOwnPropertyDescriptor" [proto; str "value"] in
    ignore (call (get descriptor "set") "call" [el; str item]);
    if value el <> item then invalid_arg "Field rejected this value"
  end else set el "textContent" (str item);
  event el "InputEvent" (obj ["bubbles", bool true; "inputType", str "insertText"; "data", str item]);
  event el "Event" (obj ["bubbles", bool true])
let tab_from el =
  ignore (key el "keydown" "Tab" 9);
  let nodes = call document "querySelectorAll" [str "input,textarea,select,button,a[href],[tabindex],[contenteditable=true]"] in
  let len : int = get nodes "length" in
  let candidates = List.init len (fun i -> get nodes i) |> List.filter (fun e ->
    not (truth (get e "disabled")) && (get e "tabIndex" : int) >= 0 &&
    (get (call e "getClientRects" []) "length" : int) > 0) in
  let rec next = function
    | a :: b :: _ when a == el -> b
    | _ :: rest -> next rest
    | [] -> (match candidates with x :: _ -> x | [] -> el) in
  let dest = next candidates in ignore (call dest "focus" []); ignore (key dest "keyup" "Tab" 9);
  if editable dest then target := dest
let run w =
  if !running then invalid_arg "Already running. Press Escape or click the status to stop first.";
  if not (connected !target && editable !target) then invalid_arg "Right-click an editable field first";
  Workflow.validate w;
  let vm = Lua_runtime.create w.script in
  active_vm := Some vm;
  running := true; incr generation;
  let token = !generation in
  let actions = ref 0 and typed = ref 0 and last_log = ref "" in
  let now () : float = call (get global "Date") "now" [] in
  let started = now () in
  let finish message = running := false; release_vm (); status message in
  let fail s = if token = !generation then finish ("linput: " ^ s ^ " — click to dismiss") in
  let text_arg = function Lua_runtime.Text s -> s | _ -> invalid_arg "Expected a string argument" in
  let schedule delay callback =
    let remaining = max 0 (int_of_float (300000. -. (now () -. started))) in
    timer (min delay remaining) callback in
  let rec loop response =
    if token = !generation && !running then protect fail (fun () ->
      if now () -. started >= 300000. then invalid_arg "Lua run exceeded the 5-minute time limit";
      match Lua_runtime.resume vm response with
      | Failed s -> fail s
      | Finished -> finish (Printf.sprintf "linput finished: %d items typed. %s Click to dismiss." !typed !last_log)
      | Slice -> schedule 0 (fun () -> loop None)
      | Action (op, arg) ->
        incr actions;
        if !actions > 10000 then invalid_arg "Lua API action limit exceeded (10000 calls)";
        status (Printf.sprintf "linput · %s · %d calls · %s · Escape or click to stop" w.name !actions !last_log);
        if List.mem op ["type"; "enter"; "tab"; "submit"; "value"; "click"] && not (connected !target) then
          invalid_arg "Target was removed; stopping rather than guessing (use linput.focus for an explicit new target)";
        let result = ref Lua_runtime.Nothing in
        let delay = match op with
          | "type" -> let item = text_arg arg in
            if String.length item > 100000 then invalid_arg "Text is too large";
            type_item !target item; incr typed; 30
          | "enter" ->
            ignore (call !target "focus" []);
            if key !target "keydown" "Enter" 13 then ignore (key !target "keypress" "Enter" 13);
            ignore (key !target "keyup" "Enter" 13); 30
          | "tab" -> tab_from !target; 30
          | "submit" ->
            let form = get !target "form" in
            let form = if defined form then form else call !target "closest" [str "form"] in
            if not (defined form) then invalid_arg "Target has no form";
            ignore (call form "requestSubmit" []); 30
          | "click" | "focus" | "exists" ->
            let selector = text_arg arg in
            if selector = "" || String.length selector > 1000 then invalid_arg "Invalid selector";
            let el = call document "querySelector" [str selector] in
            if op = "exists" then result := Boolean (defined el)
            else begin
              if not (defined el) then invalid_arg ("No element matches " ^ selector);
              if op = "focus" then begin
                let el = ancestor el in
                if not (editable el) then invalid_arg "Focus selector must match an editable field";
                ignore (call el "focus" []); target := el
              end else begin
                ignore (call el "click" []);
                let active = get document "activeElement" in
                if editable active then target := ancestor active
              end
            end; 30
          | "value" ->
            result := Text (if truth (get !target "isContentEditable") then text (get !target "textContent") else value !target); 30
          | "log" ->
            let s = text_arg arg in
            if String.length s > 1000 then invalid_arg "Log message is too large";
            last_log := s; ignore (call (get global "console") "log" [str ("linput: " ^ s)]);
            status ("linput · " ^ w.name ^ " · " ^ s ^ " · Escape or click to stop"); 30
          | "delay" -> (match arg with
              | Number ms when Float.is_finite ms && ms >= 0. && ms <= 60000. && Float.floor ms = ms -> int_of_float ms
              | _ -> invalid_arg "Delay must be an integer between 0 and 60000 ms")
          | _ -> invalid_arg ("Unknown Lua API operation: " ^ op) in
        schedule delay (fun () -> loop (Some !result))) in
  status ("linput · " ^ w.name ^ " · Escape or click to stop");
  loop None

let () =
  ignore (call document "addEventListener" [str "contextmenu"; fn (fun e ->
    if not !running then begin
      let path = call e "composedPath" [] in
      target := ancestor (get path 0)
    end); bool true]);
  ignore (call document "addEventListener" [str "keydown"; fn (fun e -> if text (get e "key") = "Escape" then stop ()); bool true]);
  ignore (call (get (get api "runtime") "onMessage") "addListener" [fn (fun message _ respond ->
    let kind = text (get message "kind") in
    if kind = "stop" then (stop (); ignore (Js.Unsafe.fun_call respond [|obj ["ok", bool true]|]))
    else if kind = "run" then protect (fun s -> status ("linput: " ^ s); ignore (Js.Unsafe.fun_call respond [|obj ["error", str s]|]))
      (fun () -> run (decode (get message "workflow")); ignore (Js.Unsafe.fun_call respond [|obj ["ok", bool true]|]));
    Js._false)])
