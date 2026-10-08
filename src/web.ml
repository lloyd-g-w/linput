open Js_of_ocaml

let global = Js.Unsafe.global
let get o k = Js.Unsafe.get o k
let set o k v = Js.Unsafe.set o k v
let str s = Js.Unsafe.inject (Js.string s)
let bool b = Js.Unsafe.inject (Js.bool b)
let num n = Js.Unsafe.inject n
let obj fields = Js.Unsafe.obj (Array.of_list fields)
let arr xs = Js.Unsafe.inject (Js.array (Array.of_list xs))
let call o k args = Js.Unsafe.meth_call o k (Array.of_list args)
let fn f = Js.Unsafe.inject (Js.wrap_callback f)
let text v = Js.to_string (Js.Unsafe.coerce v)
let null = Js.Unsafe.inject Js.null
let defined v = Js.Optdef.test (Obj.magic v) && Js.Opt.test (Obj.magic v)
let truth v = Js.to_bool (Js.Unsafe.coerce v)
let api = let b = get global "browser" in if defined b then b else get global "chrome"
let json = get global "JSON"
let stringify o = text (call json "stringify" [o])
let parse s = call json "parse" [str s]
let error e = let m = get e "message" in if defined m then text m else text e
let log s = ignore (call (get global "console") "error" [str s])
let protect on_error f = try f () with e -> on_error (Printexc.to_string e)
let then_ p success failure =
  ignore (call p "then" [fn (fun v -> protect failure (fun () -> success v)); fn (fun e -> failure (error e))])
let timer ms f = ignore (call global "setTimeout" [fn f; num ms])
let document = get global "document"
let element id = call document "getElementById" [str id]
let value el = text (get el "value")
let on el event f = ignore (call el "addEventListener" [str event; fn f])
let sync = get (get api "storage") "sync"
let prefix = "workflow:"
let encode w =
  obj ["id", str w.Workflow.id; "name", str w.name; "script", str w.script]
let string_list v = Array.to_list (Js.to_array (Js.Unsafe.coerce v)) |> List.map text
let decode v =
  let script = get v "script" in
  let script = if defined script then text script else
    Workflow.migrate (string_list (get v "items"))
      (List.map Workflow.parse_step (string_list (get v "steps"))) in
  let w = Workflow.{id = text (get v "id"); name = text (get v "name"); script} in
  Workflow.validate w; w
let keys o = string_list (call (get global "Object") "keys" [o])
let workflows data =
  keys data |> List.filter (String.starts_with ~prefix)
  |> List.filter_map (fun k -> try let w = decode (get data k) in
       if k = prefix ^ w.id then Some w else None with _ -> None)
  |> List.sort (fun a b -> String.compare a.Workflow.name b.Workflow.name)
let load success failure = then_ (call sync "get" [null]) (fun v -> success (workflows v)) failure
let save w success failure =
  Workflow.validate w;
  let v = encode w in
  (* Chrome's per-item quota counts the key and UTF-8 JSON bytes. Keep headroom. *)
  if String.length (stringify v) + String.length prefix + String.length w.id > 7500 then
    invalid_arg "Workflow exceeds sync size limit (~7 KB). Shorten the list or split it.";
  then_ (call sync "set" [obj [prefix ^ w.id, v]]) (fun _ -> success ()) failure
let send tab frame message success failure =
  then_ (call (get api "tabs") "sendMessage" [tab; message; obj ["frameId", frame]]) success failure
