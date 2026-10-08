open Web

let menus = get api "contextMenus"
let rebuilding = ref false
let pending = ref false
let rec rebuild () =
  if !rebuilding then pending := true else begin
    rebuilding := true;
    let finish () = rebuilding := false; if !pending then (pending := false; rebuild ()) in
    let fail s = log s; finish () in
    load (fun ws ->
      then_ (call menus "removeAll" []) (fun _ ->
        let create properties =
          ignore (call menus "create" [properties; fn (fun () ->
            let e = get (get api "runtime") "lastError" in if defined e then log (error e))]) in
        create (obj ["id", str "linput"; "title", str "linput"; "contexts", arr [str "editable"]]);
        List.iter (fun w -> create (obj ["id", str (prefix ^ w.Workflow.id); "parentId", str "linput";
          "title", str (String.concat "%%" (String.split_on_char '%' w.name)); "contexts", arr [str "editable"]])) ws;
        create (obj ["id", str "manage"; "parentId", str "linput"; "title", str "Manage workflows…"; "contexts", arr [str "editable"]]);
        finish ()) fail) fail
  end

let () =
  ignore (call (get menus "onClicked") "addListener" [fn (fun info tab ->
    let id = text (get info "menuItemId") in
    if id = "manage" then ignore (call (get api "runtime") "openOptionsPage" [])
    else if String.starts_with ~prefix id then
      then_ (call sync "get" [str id]) (fun data ->
        let w = decode (get data id) in
        let frame = get info "frameId" in
        send (get tab "id") (if defined frame then frame else num 0)
          (obj ["kind", str "run"; "workflow", encode w]) (fun _ -> ())
          (fun e -> log ("Cannot run here: " ^ e))) log)]);
  ignore (call (get (get api "action") "onClicked") "addListener" [fn (fun _ ->
    ignore (call (get api "runtime") "openOptionsPage" []))]);
  ignore (call (get (get api "storage") "onChanged") "addListener" [fn (fun _ area ->
    if text area = "sync" then rebuild ())]);
  rebuild ()
