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
    };
}
