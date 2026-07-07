# Materializes an npm dependency graph as Nix store paths, one derivation per
# cycle group. The deps.json spec is produced by groups.js (buildSpec).
{ depsJsonPath, nixpkgs ? <nixpkgs> }:
let
  pkgs = import nixpkgs { config = { }; overlays = [ ]; };
  inherit (pkgs) lib;
  spec = builtins.fromJSON (builtins.readFile (/. + depsJsonPath));
  inherit (spec) nodes groups memberOf subdir;

  fetchSrc = node: pkgs.fetchurl {
    url = node.tarball;
    hash = node.integrity;
  };

  groupDrvs = lib.mapAttrs mkGroup groups;

  # Directory whose node_modules/<name> is the package dir for a depPath.
  pkgDirOf = depPath: "${groupDrvs.${memberOf.${depPath}}}/${subdir.${depPath}}";

  scopeUp = alias: lib.optionalString (lib.hasPrefix "@" alias) "../";

  mkUnpack = depPath:
    let
      node = nodes.${depPath};
      dir = "$out/${subdir.${depPath}}/node_modules/${node.name}";
    in ''
      mkdir -p "${dir}"
      tar -xzf ${fetchSrc node} --strip-components=1 --warning=no-unknown-keyword \
        --delay-directory-restore --no-same-owner --no-same-permissions -C "${dir}"
      chmod -R u+w "${dir}"
      ${lib.optionalString (node ? patch) ''
        ${pkgs.gitMinimal}/bin/git -C "${dir}" apply --whitespace=nowarn ${pkgs.writeText "pnpm-patch" node.patch.content}
      ''}
      jq -r '.bin // empty | if type == "string" then [.] else [.[]] end | .[]' "${dir}/package.json" \
        | while IFS= read -r binFile; do chmod +x "${dir}/$binFile" || true; done
    '';

  mkDepLinks = groupKey: memberDepPath:
    let
      node = nodes.${memberDepPath};
      linkDir = "$out/${subdir.${memberDepPath}}/node_modules";
      mkLink = alias: dep:
        let
          target =
            if memberOf.${dep.depPath} == groupKey
            then "${scopeUp alias}../../${subdir.${dep.depPath}}/node_modules/${dep.name}"
            else "${pkgDirOf dep.depPath}/node_modules/${dep.name}";
        in ''
          mkdir -p "${linkDir}/${builtins.dirOf alias}"
          ln -s "${target}" "${linkDir}/${alias}"
        '';
    in lib.concatStrings (lib.mapAttrsToList mkLink (node.deps or { }));

  # Lifecycle scripts are detected from package.json at build time because
  # pnpm cannot know requiresBuild before fetching the tarball; the runner
  # exits immediately for the (vast majority of) script-free packages.
  mkBuild = depPath:
    let node = nodes.${depPath}; in ''
      node ${./run-scripts.cjs} "$out/${subdir.${depPath}}/node_modules/${node.name}"
    '';

  # ponytail: native addons (node-gyp) will fail — only nodejs, jq, and stdenv
  # are in the build environment; per-package extra build inputs are the
  # upgrade path when someone needs them.
  mkGroup = groupKey: group:
    pkgs.runCommand group.drvName
      {
        nativeBuildInputs = [ pkgs.jq pkgs.nodejs ];
        pnpmEngine = nodes.${groupKey}.engine or "";
      }
      ''
        ${lib.concatMapStrings mkUnpack group.members}
        ${lib.concatMapStrings (mkDepLinks groupKey) group.members}
        ${lib.concatMapStrings mkBuild group.members}
      '';
in {
  anchor = pkgs.writeTextFile {
    name = "pnpm-nix-manifest";
    destination = "/manifest.json";
    # Interpolating the store paths gives the manifest a reference on every
    # group, so one gc root on the anchor protects the whole closure.
    text = builtins.toJSON (lib.mapAttrs (depPath: _: pkgDirOf depPath) memberOf);
  };
}
