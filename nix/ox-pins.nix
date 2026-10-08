# Toolchain subset of prigh's working OxCaml switch. Explicit versions keep the
# opam-nix solve small and allow reuse of prigh's binary cache.
{
  ocaml = "5.2.0";
  ocaml-variants = "5.2.0+ox";
  oxcaml-compiler = "5.2.0minus39";
  oxcaml = "latest";
  ocaml-config = "3";
  ocaml-options-vanilla = "1";
  dune = "3.22.2+ox";
  js_of_ocaml = "6.3.2+ox";
  js_of_ocaml-compiler = "6.3.2+ox";
  ocamlfind = "1.9.8+ox";
  ocaml-compiler-libs = "v0.17.0+ox";
  ppxlib = "0.33.0+ox2";
  ppxlib_ast = "0.33.0+ox2";
  ppxlib_jane = "v0.18~preview.130.106+341";
  ppx_derivers = "1.2.1";
  sexplib0 = "v0.18~preview.130.106+341";
  sexp_type = "v0.18~preview.130.106+341";
  basement = "v0.18~preview.130.106+341";
  stdlib-shims = "0.3.0";
  cmdliner = "2.1.1";
  sedlex = "3.7+ox";
  gen = "1.1";
  yojson = "2.2.2+ox";
  seq = "base";
  menhir = "20260209";
  menhirLib = "20260209";
  menhirSdk = "20260209";
  menhirCST = "20260209";
  menhirGLR = "20260209";
  conf-autoconf = "0.2";
  conf-which = "1";
}
