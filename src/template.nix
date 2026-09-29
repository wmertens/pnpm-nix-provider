# Materializes an npm dependency graph as Nix store paths, one derivation per
# cycle group. The deps.json spec is produced by groups.js (buildSpec):
#   nodes/groups/memberOf/subdir — the graph and its layout
#   rules  — per-group build requirements (extra nixpkgs inputs, env vars)
#   pinned — groups already materialized outside this eval (host builds);
#            their paths are imported with builtins.storePath instead of built
# mode "full" assembles complete packages (dep links + lifecycle scripts);
# mode "raw" stops after unpack+patch (used by the impure host-build path).
# overridesPath names a user file `{ pkgs, lib }: { "<name>" = drv: drv; }`
# whose functions are applied to the assembled group derivations.
{ depsJsonPath, nixpkgs ? <nixpkgs>, mode ? "full", overridesPath ? null }:
let
  assemble = mode == "full";
  pkgs = import nixpkgs { config = { }; overlays = [ ]; };
  inherit (pkgs) lib;
  spec = builtins.fromJSON (builtins.readFile (/. + depsJsonPath));
  inherit (spec) nodes groups memberOf subdir;
  rules = spec.rules or { };
  pinned = spec.pinned or { };

  # Registry tarballs are fetched as fixed-output derivations; local
  # directories (file:/injected deps — install-time snapshots in pnpm) are
  # imported content-addressed with node_modules and VCS files filtered out;
  # git deps are fetched by commit.
  srcOf = node:
    if node ? directory then
      lib.cleanSourceWith {
        name = "${baseNameOf node.directory}-source";
        src = /. + node.directory;
        filter = p: type: baseNameOf p != "node_modules" && baseNameOf p != ".git";
      }
    else if node ? git then
      builtins.fetchGit {
        url = lib.removePrefix "git+" node.git.repo;
        rev = node.git.commit;
        allRefs = true;
      }
    else
      pkgs.fetchurl {
        url = node.tarball;
        hash = node.integrity;
      };

  resolveInput = name:
    lib.attrByPath (lib.splitString "." name)
      (throw "pnpm-nix build rule input '${name}' not found in nixpkgs")
      pkgs;

  ruleEnv = rule: builtins.mapAttrs
    (_: value: if builtins.isAttrs value then "${resolveInput value.drv}" else value)
    (rule.env or { });

  overrides =
    if overridesPath == null
    then { }
    else import (/. + overridesPath) { inherit pkgs lib; };

  # Overrides only touch assembled builds; raw unpack derivations stay
  # stable so the impure host path shares them regardless of overrides.
  # For cycle groups the lookup uses the group's first member.
  applyOverride = groupKey: drv:
    let
      node = nodes.${groupKey};
      override = overrides."${node.name}@${node.version}" or (overrides.${node.name} or (overrides."*" or null));
    in if assemble && override != null then override drv else drv;

  groupDrvs = lib.mapAttrs (groupKey: group: applyOverride groupKey (mkGroup groupKey group)) groups;

  rootOf = groupKey:
    if pinned ? ${groupKey}
    then builtins.storePath pinned.${groupKey}
    else groupDrvs.${groupKey};

  # Directory whose node_modules/<name> is the package dir for a depPath.
  pkgDirOf = depPath: "${rootOf memberOf.${depPath}}/${subdir.${depPath}}";

  scopeUp = alias: lib.optionalString (lib.hasPrefix "@" alias) "../";

  mkUnpack = depPath:
    let
      node = nodes.${depPath};
      dir = "$out/${subdir.${depPath}}/node_modules/${node.name}";
      unpack =
        if node ? tarball then ''
          tar -xzf ${srcOf node} --strip-components=1 --warning=no-unknown-keyword \
            --delay-directory-restore --no-same-owner --no-same-permissions -C "${dir}"
        '' else ''
          cp -a ${srcOf node}/. "${dir}/"
        '';
    in ''
      mkdir -p "${dir}"
      ${unpack}
      chmod -R u+w "${dir}"
      ${lib.optionalString (node ? patch) ''
        ${pkgs.gitMinimal}/bin/git -C "${dir}" apply --ignore-whitespace --whitespace=nowarn ${pkgs.writeText "pnpm-patch" node.patch.content}
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

  mkGroup = groupKey: group:
    let rule = rules.${groupKey} or { }; in
    pkgs.runCommand group.drvName
      ({
        nativeBuildInputs = [ pkgs.jq ]
          ++ lib.optional assemble pkgs.nodejs
          ++ lib.optionals assemble (map resolveInput (rule.extraInputs or [ ]));
      } // lib.optionalAttrs assemble ({ pnpmEngine = nodes.${groupKey}.engine or ""; } // ruleEnv rule))
      ''
        ${lib.concatMapStrings mkUnpack group.members}
        ${lib.optionalString assemble ''
          ${lib.concatMapStrings (mkDepLinks groupKey) group.members}
          ${lib.concatMapStrings mkBuild group.members}
        ''}
      '';
in {
  # Interpolating the store paths gives the manifest a reference on every
  # group — pinned ones included — so one gc root on the anchor protects the
  # whole closure.
  anchor = pkgs.writeTextFile {
    name = "pnpm-nix-manifest";
    destination = "/manifest.json";
    text = builtins.toJSON (lib.mapAttrs (depPath: _: pkgDirOf depPath) memberOf);
  };
  groups = groupDrvs;
}
