# Wraps an existing set of store paths — including impurely added ones that
# carry no reference metadata — in a manifest derivation, so one gc root on
# the anchor protects them all. builtins.storePath turns the bare path
# strings back into real store references.
{ manifestPath, nixpkgs ? <nixpkgs> }:
let
  pkgs = import nixpkgs { config = { }; overlays = [ ]; };
  manifest = builtins.fromJSON (builtins.readFile (/. + manifestPath));
  withReferences = builtins.mapAttrs
    (_: p:
      let m = builtins.match "(/nix/store/[^/]+)(.*)" p;
      in "${builtins.storePath (builtins.elemAt m 0)}${builtins.elemAt m 1}")
    manifest;
in {
  anchor = pkgs.writeTextFile {
    name = "pnpm-nix-manifest";
    destination = "/manifest.json";
    text = builtins.toJSON withReferences;
  };
}
