open Js_of_ocaml
open Web

let current = ref ""
let saved = ref []
let clean_name = ref ""
let clean_script = ref ""
let saving = ref false
let editor = get global "LinputEditor"
let has_editor () = defined editor
let script_value () = if has_editor () then text (call editor "getValue" []) else value (element "script")
let update_diagnostics () =
  if has_editor () && defined (get editor "checkSyntax") then ignore (call editor "checkSyntax" [])
let set_script s =
  if has_editor () then ignore (call editor "setValue" [str s])
  else set (element "script") "value" (str s)
let optional_text id s = let el = element id in if defined el then set el "textContent" (str s)
let status s =
  let el = element "status" in
  set el "textContent" (str s);
  let known prefixes = List.exists (fun prefix -> String.starts_with ~prefix s) prefixes in
  let tone = if known ["Saved"; "Loaded"; "Syntax valid"; "Imported"; "Deleted"] then "success"
    else if known ["New"; "Converted"; "Inserted"; "Exported"; "Stop"] then "info" else "error" in
  ignore (call el "setAttribute" [str "data-tone"; str tone])
let guard f = try f () with
  | Invalid_argument s -> status ("Error: " ^ s)
  | e -> status ("Error: " ^ Printexc.to_string e)
let dirty () = value (element "name") <> !clean_name || script_value () <> !clean_script
let update_editor_state () =
  set (element "delete") "disabled" (bool (!current = "" || !saving));
  let is_saved = !current <> "" && not (dirty ()) in
  optional_text "editor-state" (if is_saved then "All changes saved" else if !current = "" then "Unsaved draft" else "Unsaved changes");
  let badge = element "editor-state" in
  if defined badge then ignore (call badge "setAttribute" [str "data-state"; str (if is_saved then "saved" else "dirty")]);
  let name = String.trim (value (element "name")) in
  optional_text "editor-title" (if name = "" then "Untitled workflow" else name);
  let id = if !current = "" then String.make 36 '0' else !current in
  let w = Workflow.{id; name; script = script_value ()} in
  let size = String.length (stringify (encode w)) + String.length prefix + String.length id in
  optional_text "script-size" (Printf.sprintf "%d B / 7.5 KB" size);
  let size_el = element "script-size" in
  if defined size_el then ignore (call size_el "setAttribute" [str "data-over-limit"; str (string_of_bool (size > 7500))])
let mark_clean name script = clean_name := name; clean_script := script; update_editor_state ()
let fill w =
  current := w.Workflow.id;
  set (element "workflows") "value" (str w.id);
  set (element "name") "value" (str w.name);
  set_script w.script;
  mark_clean w.name w.script
let fresh () =
  current := "";
  set (element "workflows") "value" (str "");
  set (element "name") "value" (str "");
  set_script Workflow.template;
  set (element "items") "value" (str "");
  set (element "converted") "value" (str "");
  mark_clean "" Workflow.template;
  optional_text "list-count" "0 items";
  status "New workflow. Give it a name, write your Lua, then save."
let refresh done_ = load (fun ws ->
  saved := ws;
  optional_text "workflow-count" (string_of_int (List.length ws));
  let select = element "workflows" in set select "textContent" (str "");
  let add id label = let el = call document "createElement" [str "option"] in
    set el "value" (str id); set el "textContent" (str label); ignore (call select "appendChild" [el]) in
  add "" "Choose a workflow…";
  List.iter (fun w -> add w.Workflow.id w.name) ws;
  set select "value" (str !current); done_ ()) status
let read_form () =
  let id = if !current = "" then text (call (get global "crypto") "randomUUID" []) else !current in
  Workflow.{ id; name = String.trim (value (element "name")); script = script_value () }
let confirm s = truth (call global "confirm" [str s])
let () =
  set global "LinputLuaCheck" (fn (fun source ->
    let source = text source in
    try
      if String.length source > 20000 then invalid_arg "Lua script is too large";
      Lua_runtime.check source; null
    with Invalid_argument s -> str s | e -> str (Printexc.to_string e)));
  if has_editor () then ignore (call editor "create" []);
  on (element "script") "input" (fun _ -> update_editor_state ());
  on (element "name") "input" (fun _ -> update_editor_state ());
  on (element "items") "input" (fun _ ->
    optional_text "list-count" (Printf.sprintf "%d items" (List.length (Workflow.words (value (element "items"))))));
  let validate = element "validate" in
  if defined validate then on validate "click" (fun _ -> guard (fun () ->
    let script = script_value () in
    update_diagnostics ();
    if String.trim script = "" then invalid_arg "Add a Lua script";
    if String.length script > 20000 then invalid_arg "Lua script is too large";
    Lua_runtime.check script;
    status "Syntax valid. Ready to save — checking does not run your script."));
  ignore (call document "addEventListener" [str "keydown"; fn (fun e ->
    if not (truth (get e "defaultPrevented")) && (truth (get e "ctrlKey") || truth (get e "metaKey")) then
      let key = text (get e "key") in
      if key = "s" || key = "S" || key = "Enter" then begin
        ignore (call e "preventDefault" []);
        let button = element (if key = "Enter" then "validate" else "save") in
        if defined button then ignore (call button "click" [])
      end)]);
  on global "beforeunload" (fun e ->
    if dirty () then begin
      ignore (call e "preventDefault" []);
      set e "returnValue" (str "")
    end);
  on (element "convert") "click" (fun _ -> guard (fun () ->
    let input = value (element "items") in
    if String.length input > 100000 then invalid_arg "Input list is too large";
    let items = Workflow.words input in
    if List.length items > 1000 then invalid_arg "Converter supports up to 1000 items";
    set (element "converted") "value" (str (Workflow.lua_list items));
    optional_text "list-count" (Printf.sprintf "%d items" (List.length items));
    status (Printf.sprintf "Converted %d items. Copy the Lua list, or select the old declaration and insert." (List.length items))));
  on (element "insert-list") "click" (fun _ -> guard (fun () ->
    let converted = value (element "converted") in
    if converted = "" then invalid_arg "Convert a list first";
    if has_editor () then ignore (call editor "replaceSelection" [str converted]) else begin
      let textarea = element "script" in
      ignore (call textarea "setRangeText" [str converted; get textarea "selectionStart"; get textarea "selectionEnd"; str "end"]);
      ignore (call textarea "focus" [])
    end;
    update_editor_state ();
    status "Inserted at the cursor/replaced the selection. Review your script, then save."));
  on (element "new") "click" (fun _ ->
    if not (dirty ()) || confirm "Discard unsaved changes and start a new workflow?" then fresh ());
  on (element "workflows") "change" (fun _ ->
    let id = value (element "workflows") in
    if dirty () && not (confirm "Discard unsaved changes and open another workflow?") then
      set (element "workflows") "value" (str !current)
    else match List.find_opt (fun w -> w.Workflow.id = id) !saved with
      | Some w -> fill w; status "Loaded. Right-click an editable field to run this workflow."
      | None -> fresh ());
  on (element "save") "click" (fun _ -> if !saving then () else guard (fun () ->
    let w = read_form () in
    update_diagnostics ();
    Workflow.validate w;
    Lua_runtime.check w.script;
    if !current = "" && List.length !saved >= 20 then invalid_arg "Maximum 20 workflows";
    let name_before = value (element "name") in
    let set_busy busy =
      saving := busy;
      List.iter (fun id -> set (element id) "disabled" (bool busy)) ["save"; "new"; "workflows"; "import"];
      update_editor_state () in
    set_busy true;
    try save w (fun () ->
      set_busy false; current := w.id;
      if value (element "name") = name_before then set (element "name") "value" (str w.name);
      mark_clean w.name w.script;
      refresh (fun () -> status (if dirty () then "Saved snapshot. Your newer edits are still unsaved."
        else "Saved to browser-account sync storage.")))
      (fun s -> set_busy false; status s)
    with e -> set_busy false; raise e));
  on (element "delete") "click" (fun _ ->
    if !current <> "" && confirm "Delete this saved workflow?" then
      then_ (call sync "remove" [str (prefix ^ !current)]) (fun _ -> fresh (); refresh (fun () -> status "Deleted.")) status);
  on (element "stop") "click" (fun _ ->
    then_ (call (get api "tabs") "query" [obj []]) (fun tabs ->
      Array.iter (fun tab ->
        let p = call (get api "tabs") "sendMessage" [get tab "id"; obj ["kind", str "stop"]] in
        then_ p (fun _ -> ()) (fun _ -> ())) (Js.to_array (Js.Unsafe.coerce tabs));
      status "Stop sent to all open tabs.") status);
  on (element "export") "click" (fun _ ->
    load (fun ws ->
      let data = stringify (obj ["version", num 2; "workflows", arr (List.map encode ws)]) in
      let blob = Js.Unsafe.new_obj (get global "Blob") [|arr [str data]; obj ["type", str "application/json"]|] in
      let url = call (get global "URL") "createObjectURL" [blob] in
      let a = call document "createElement" [str "a"] in
      set a "href" url; set a "download" (str "linput-workflows.json"); ignore (call a "click" []);
      timer 1000 (fun () -> ignore (call (get global "URL") "revokeObjectURL" [url]));
      status "Exported. This file contains your input lists; keep it private.") status);
  on (element "import") "change" (fun _ -> guard (fun () ->
    let files = get (element "import") "files" in
    if (get files "length" : int) > 0 then begin
      let file = get files 0 in
      if (get file "size" : int) > 200000 then invalid_arg "Import file is too large";
      then_ (call file "text" []) (fun data -> guard (fun () ->
        let root = parse (text data) in
        let version : int = get root "version" in
        if version <> 1 && version <> 2 then invalid_arg "Unsupported export version";
        let ws = Array.to_list (Js.to_array (Js.Unsafe.coerce (get root "workflows"))) |> List.map decode in
        if ws = [] then invalid_arg "No workflows to import";
        let combined = List.sort_uniq String.compare (List.map (fun w -> w.Workflow.id) (ws @ !saved)) in
        if List.length combined > 20 then invalid_arg "Import would exceed 20 workflows";
        let fields = List.map (fun w -> Lua_runtime.check w.Workflow.script;
          let v = encode w in let k = prefix ^ w.Workflow.id in
          if String.length k + String.length (stringify v) > 7500 then invalid_arg "An imported workflow exceeds the sync size limit";
          k, v) ws in
        if confirm "Import workflows? Matching IDs will be overwritten; other workflows are kept." then
          then_ (call sync "set" [obj fields]) (fun _ -> refresh (fun () -> status "Imported.")) status)) status;
      set (element "import") "value" (str "")
    end));
  refresh fresh
