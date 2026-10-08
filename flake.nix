{
  description = "Linput — OxCaml/Lua browser workflow extension";

  # Same cache/toolchain baseline as prigh. Nix asks before trusting this config.
  nixConfig = {
    extra-substituters = [ "https://prigh.cachix.org" ];
    extra-trusted-public-keys = [
      "prigh.cachix.org-1:1kHKoGOetNmpzJg8lJ1nvQzwzTL0XiOs5GInELMgSoI="
    ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/e554fab72f81915600f3f449b786fd9af40439a5";
    flake-utils.url = "github:numtide/flake-utils/11707dc2f618dd54ca8739b309ec4fc024de578b";
    opam-nix.url = "github:tweag/opam-nix/c6a5487ee20d976bb4eb08c0c92a693178206eb4";
    opam-repository = {
      url = "github:ocaml/opam-repository/8cdfa3296d9bc7d93273f46eb2438757e4fd5cf0";
      flake = false;
    };
    ox-opam-repository = {
      url = "github:oxcaml/opam-repository/bb4555262936283daf5cbc82423509d4e7069b15";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      opam-nix,
      opam-repository,
      ox-opam-repository,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        lib = pkgs.lib;
        # Do not override opam-nix's bootstrap nixpkgs: keeping prigh's baseline
        # and compiler patches unchanged allows its cached toolchain to be reused.
        scope =
          (opam-nix.lib.${system}.queryToScope {
            repos = [
              ox-opam-repository
              opam-repository
            ];
            resolveArgs = {
              depopts = false;
              dev = false;
            };
          } (import ./nix/ox-pins.nix)).overrideScope
            (
              final: prev: {
                oxcaml-compiler = prev.oxcaml-compiler.overrideAttrs (old: {
                  patches = (old.patches or [ ]) ++ [
                    ./nix/fix-floatarithmem.patch
                    ./nix/limit-dune-jobs.patch
                  ];
                  nativeBuildInputs =
                    (old.nativeBuildInputs or [ ])
                    ++ lib.optionals pkgs.stdenv.hostPlatform.isDarwin [ pkgs.darwin.cctools ];
                  env = (old.env or { }) // lib.optionalAttrs pkgs.stdenv.hostPlatform.isDarwin { JOBS = "2"; };
                });
              }
            );
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./dune-project
            ./linput.opam
            ./src
            ./extension
            ./scripts
            ./tests
            ./package.json
            ./package-lock.json
          ];
        };
        extension = pkgs.buildNpmPackage {
          pname = "linput";
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          inherit src;
          npmDepsHash = "sha256-Xlh5dONEomEq05sbF8kW4qLe2DA0K8tQAaPOw0izmVI=";
          npmFlags = [
            "--no-audit"
            "--no-fund"
          ];
          # All dependencies, including esbuild's platform binary, are locked.
          # No dependency install script or network access is needed to bundle.
          npmRebuildFlags = [ "--ignore-scripts" ];
          nativeBuildInputs = [
            scope.ocaml
            scope.dune
            scope.ocamlfind
            scope.js_of_ocaml-compiler
          ];
          buildInputs = [ scope.js_of_ocaml ];
          buildPhase = ''
            runHook preBuild
            bash scripts/build.sh
            runHook postBuild
          '';
          doCheck = true;
          checkPhase = ''
            runHook preCheck
            npm test
            runHook postCheck
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp -r dist/chrome dist/firefox "$out/"
            runHook postInstall
          '';
          meta = {
            description = "Account-synced Lua workflows for Chrome and Firefox";
            platforms = lib.platforms.unix;
          };
        };
        chromeZip =
          pkgs.runCommand "linput-chrome-zip-${extension.version}" { nativeBuildInputs = [ pkgs.zip ]; }
            ''
              export LC_ALL=C TZ=UTC
              mkdir -p "$out"
              cp -r ${extension}/chrome staging
              cd staging
              find . -type d -exec chmod 755 {} +
              find . -type f -exec chmod 644 {} +
              # ZIP's DOS timestamp starts in 1980; normalize permissions, order and
              # timestamps, and omit host-specific extra fields for reproducibility.
              find . -exec touch -t 198001010000.00 {} +
              find . -type f -printf '%P\n' | sort | zip -X -q "$out/linput-chrome.zip" -@
            '';
        browserPackage =
          browser:
          pkgs.runCommand "linput-${browser}" { } ''
            ln -s ${extension}/${browser} "$out"
          '';
      in
      {
        legacyPackages = scope;
        packages = {
          default = extension;
          inherit extension;
          chrome-zip = chromeZip;
          chrome = browserPackage "chrome";
          firefox = browserPackage "firefox";
        };
        checks = {
          build-and-tests = extension;
          chrome-zip = pkgs.runCommand "linput-chrome-zip-check" { nativeBuildInputs = [ pkgs.python3 ]; } ''
            python3 ${./tests/chrome_zip.py} ${chromeZip}/linput-chrome.zip ${extension}/chrome
            touch "$out"
          '';
          manifests = pkgs.runCommand "linput-manifest-check" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
            node ${./tests/manifests.cjs} ${extension}
            touch "$out"
          '';
        };
        devShells.default = pkgs.mkShell {
          inputsFrom = [ extension ];
          packages = [
            pkgs.nodejs
            pkgs.nixfmt
            pkgs.ripgrep
            pkgs.which
            pkgs.prefetch-npm-deps
            pkgs.librsvg
          ]
          ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.chromium ];
          shellHook = ''
            echo "Linput: OxCaml + Node. npm ci; bash scripts/build.sh; npm test"
          '';
        };
        formatter = pkgs.nixfmt;
      }
    );
}
