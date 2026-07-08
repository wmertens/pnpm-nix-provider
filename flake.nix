{
  description = "pnpm package provider that materializes node_modules from the Nix store";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      eachSystem = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
    in {
      packages = eachSystem (system: pkgs: rec {
        pnpm-nix-provider = pkgs.stdenvNoCC.mkDerivation {
          pname = "pnpm-nix-provider";
          version = "0.1.0";
          src = ./.;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/pnpm-nix-provider
            cp -r src $out/lib/pnpm-nix-provider/
            # --set-default: fall back to this flake's pinned nixpkgs on
            # flakes-only systems where no channel provides <nixpkgs>.
            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/pnpm-nix-provider \
              --add-flags $out/lib/pnpm-nix-provider/src/cli.js \
              --set-default NIX_PATH "nixpkgs=${nixpkgs}"
            runHook postInstall
          '';
        };
        default = pnpm-nix-provider;
      });

      apps = eachSystem (system: pkgs: rec {
        pnpm-nix-provider = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/pnpm-nix-provider";
        };
        default = pnpm-nix-provider;
      });

      # The module test evaluates it against stubs of the home-manager
      # options it writes to (home.packages, home.sessionVariables,
      # xdg.configFile.<name>.text). The module only relies on core module
      # system semantics, so the stubs are faithful; a real home-manager
      # input stays out of the flake so consumers don't have to lock it.
      checks = eachSystem (system: pkgs:
        let
          lib = nixpkgs.lib;
          stubHomeManagerOptions = {
            options = {
              home.packages = lib.mkOption {
                type = lib.types.listOf lib.types.package;
                default = [ ];
              };
              home.sessionVariables = lib.mkOption {
                type = lib.types.attrsOf lib.types.str;
                default = { };
              };
              xdg.configFile = lib.mkOption {
                type = lib.types.attrsOf (lib.types.submodule {
                  options.text = lib.mkOption {
                    type = lib.types.nullOr lib.types.lines;
                    default = null;
                  };
                });
                default = { };
              };
            };
          };
          evalWith = settings: (lib.evalModules {
            modules = [
              stubHomeManagerOptions
              self.homeManagerModules.default
              { _module.args.pkgs = pkgs; }
              { programs.pnpm-nix-provider = settings; }
            ];
          }).config;
          enabled = evalWith {
            enable = true;
            impure = true;
            rules.foo.extraInputs = [ "hello" ];
            overrides = "{ pkgs, lib }: { }";
          };
          defaults = evalWith { enable = true; };
          selfManaged = evalWith { enable = true; configurePnpm = false; };
          disabled = evalWith { };
          asserts = [
            {
              ok = enabled.xdg.configFile."pnpm/config.yaml".text == "packageProvider: pnpm-nix-provider\n";
              msg = "enable should point pnpm at the provider";
            }
            {
              ok = enabled.xdg.configFile."pnpm-nix/rules.json".text == builtins.toJSON { foo.extraInputs = [ "hello" ]; };
              msg = "rules should serialize to rules.json";
            }
            {
              ok = enabled.xdg.configFile."pnpm-nix/overrides.nix".text == "{ pkgs, lib }: { }";
              msg = "overrides should be written verbatim";
            }
            {
              ok = enabled.home.sessionVariables.PNPM_NIX_IMPURE or null == "1";
              msg = "impure should export PNPM_NIX_IMPURE=1";
            }
            {
              ok = lib.any (p: lib.getName p == "pnpm-nix-provider") enabled.home.packages;
              msg = "enable should install the provider package";
            }
            {
              ok = !(defaults.xdg.configFile ? "pnpm-nix/rules.json") && !(defaults.xdg.configFile ? "pnpm-nix/overrides.nix");
              msg = "empty rules/overrides should write no files";
            }
            {
              ok = !(defaults.home.sessionVariables ? PNPM_NIX_IMPURE);
              msg = "impure should default off";
            }
            {
              ok = !(selfManaged.xdg.configFile ? "pnpm/config.yaml");
              msg = "configurePnpm = false should leave pnpm's config alone";
            }
            {
              ok = disabled.home.packages == [ ] && disabled.xdg.configFile == { };
              msg = "the module should be inert when disabled";
            }
          ];
          failures = builtins.filter (a: !a.ok) asserts;
        in {
          home-manager-module =
            if failures == [ ]
            then pkgs.runCommand "home-manager-module-test" { } "touch $out"
            else throw "home-manager module test failed: ${lib.concatMapStringsSep "; " (a: a.msg) failures}";
        });

      homeManagerModules = rec {
        pnpm-nix-provider = { config, lib, pkgs, ... }:
          let cfg = config.programs.pnpm-nix-provider;
          in {
            options.programs.pnpm-nix-provider = {
              enable = lib.mkEnableOption "the pnpm Nix package provider";
              configurePnpm = lib.mkOption {
                type = lib.types.bool;
                default = true;
                description = ''
                  Write `packageProvider: pnpm-nix-provider` to pnpm's global
                  config.yaml so every install uses the provider. Disable this
                  if you manage pnpm's global config yourself (e.g. with
                  `pnpm config set -g`) — pnpm cannot edit the file while
                  home-manager owns it.
                '';
              };
              rules = lib.mkOption {
                type = lib.types.attrs;
                default = { };
                example = { better-sqlite3.extraInputs = [ "python3" ]; };
                description = "Build rules, written to pnpm-nix/rules.json.";
              };
              overrides = lib.mkOption {
                type = lib.types.nullOr lib.types.lines;
                default = null;
                example = ''
                  { pkgs, lib }: {
                    "sharp" = drv: drv.overrideAttrs (prev: {
                      nativeBuildInputs = prev.nativeBuildInputs ++ [ pkgs.vips ];
                    });
                  }
                '';
                description = "Nix build overrides, written to pnpm-nix/overrides.nix.";
              };
              impure = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = "Allow host builds as a last resort (PNPM_NIX_IMPURE=1).";
              };
            };
            config = lib.mkIf cfg.enable {
              home.packages = [ self.packages.${pkgs.stdenv.hostPlatform.system}.default ];
              home.sessionVariables = lib.mkIf cfg.impure { PNPM_NIX_IMPURE = "1"; };
              xdg.configFile = {
                "pnpm-nix/rules.json" = lib.mkIf (cfg.rules != { }) { text = builtins.toJSON cfg.rules; };
                "pnpm-nix/overrides.nix" = lib.mkIf (cfg.overrides != null) { text = cfg.overrides; };
                "pnpm/config.yaml" = lib.mkIf cfg.configurePnpm { text = "packageProvider: pnpm-nix-provider\n"; };
              };
            };
          };
        default = pnpm-nix-provider;
      };
    };
}
