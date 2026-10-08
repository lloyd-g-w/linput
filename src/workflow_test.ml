open Workflow
let rejects f = try f (); failwith "Expected validation failure" with Invalid_argument _ -> ()
let () =
  assert (words "z5599988 z5599988\r\nz42\tlast" = ["z5599988"; "z5599988"; "z42"; "last"]);
  assert (parse_steps "type\nenter\ndelay 250\nclick button.save\ntab\nsubmit\n" =
    [Type; Enter; Delay 250; Click "button.save"; Tab; Submit]);
  List.iter (fun s -> assert (parse_step (string_of_step s) = s)) [Type; Enter; Tab; Submit; Delay 0; Delay 60000; Click "#save"];
  List.iter (fun s -> rejects (fun () -> ignore (parse_step s))) ["delay -1"; "delay 60001"; "delay nope"; "click "; "oops"];
  assert (lua_quote "a\"b\\c\n\r\t\0001" = "\"a\\\"b\\\\c\\n\\r\\t\\0001\"");
  assert (lua_list ["a"; "a"] = "local items = {\n  \"a\",\n  \"a\",\n}\n");
  assert (lua_list [] = "local items = {\n}\n");
  assert (migrate ["a"] [Type; Enter; Delay 10; Click "#save"; Tab; Submit] =
    "local items = {\n  \"a\",\n}\nfor _, item in ipairs(items) do\n  linput.type(item)\n  linput.enter()\n  linput.delay(10)\n  linput.click(\"#save\")\n  linput.tab()\n  linput.submit()\nend\n");
  let w = {id="test"; name="Test"; script=template} in
  validate w;
  validate {w with script="linput.log('hello')"};
  rejects (fun () -> validate {w with name=""});
  rejects (fun () -> validate {w with script=" \n"});
  rejects (fun () -> validate {w with script=String.make 20001 'a'});
  print_endline "Workflow and Lua converter tests passed"
