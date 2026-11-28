{
  description = "xiv-market — FFXIV market board viewer (Solid.js + Vite + bun) and its Universalis proxy (Rust)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # crane 只做 cargo 构建库，自身不带 nixpkgs 输入，pkgs 由本 flake 传入。
    crane.url = "github:ipetkov/crane";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      crane,
      rust-overlay,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      # rust-overlay 叠到 pkgs 上，pkgs.rust-bin 才可用（源码安装的固定版本工具链）。
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f (
            import nixpkgs {
              inherit system;
              overlays = [ (import rust-overlay) ];
            }
          )
        );

      # 构建与 devShell 共用同一套 cargo/rustc，避免两边版本不一致。
      mkCraneLib =
        pkgs:
        (crane.mkLib pkgs).overrideToolchain (
          p:
          p.rust-bin.stable.latest.default.override {
            extensions = [
              "rustfmt"
              "clippy"
            ];
          }
        );

      mkPackage =
        pkgs:
        let
          shadowConfig = builtins.fromTOML (builtins.readFile ./shadow.toml);
          itemsRef = builtins.fromTOML (builtins.readFile ./.shadow/refs/data/items.json.ref);
          itemsDigest = pkgs.lib.removePrefix "sha256:" itemsRef.oid;
          itemsKey = pkgs.lib.concatStringsSep "/" (
            pkgs.lib.optional (shadowConfig.backend.prefix != "") shadowConfig.backend.prefix
            ++ [
              shadowConfig.name
              "objects"
              "sha256"
              (builtins.substring 0 2 itemsDigest)
              (builtins.substring 2 62 itemsDigest)
            ]
          );
          itemsOrigin =
            builtins.replaceStrings [ "https://" ] [ "https://${shadowConfig.backend.bucket}." ]
              shadowConfig.backend.endpoint;
          itemsData = pkgs.fetchurl {
            name = "xiv-market-items.json";
            url = "${itemsOrigin}/${itemsKey}";
            sha256 = itemsDigest;
          };
          bunDeps = pkgs.stdenv.mkDerivation {
            pname = "xiv-market-bun-deps";
            version = "0.0.0";
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                ./package.json
                ./bun.lock
                ./app/package.json
                ./packages/shared/package.json
                ./packages/ui/package.json
              ];
            };
            nativeBuildInputs = [
              pkgs.bun
              pkgs.nodejs_24
              pkgs.cacert
            ];
            buildPhase = ''
              runHook preBuild
              export HOME=$TMPDIR
              export BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
              export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
              bun install --frozen-lockfile --ignore-scripts \
                --os=${if pkgs.stdenv.hostPlatform.isDarwin then "darwin" else "linux"} \
                --cpu=${if pkgs.stdenv.hostPlatform.isAarch64 then "arm64" else "x64"}
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p $out
              cp -a node_modules $out/
              for workspace in app packages/shared packages/ui; do
                if [ -d $workspace/node_modules ]; then
                  mkdir -p $out/$workspace
                  cp -a $workspace/node_modules $out/$workspace/
                fi
              done
              runHook postInstall
            '';
            # Keep downloaded package contents identical across builders.
            dontFixup = true;
            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash =
              {
                x86_64-linux = "sha256-3/DE0LkrC6melJmlKW4pesdnC6SaEGRWi81gSPluSnc=";
                aarch64-darwin = "sha256-0+02EGB6uaDnfmnGOamCLafjcKck2dgguutwrU+d7Mk=";
              }
              .${pkgs.stdenv.hostPlatform.system}
                or (throw "xiv-market bun dependencies hash is not pinned for ${pkgs.stdenv.hostPlatform.system}");
          };
        in
        pkgs.stdenv.mkDerivation {
          pname = "xiv-market";
          version = "0.0.0";
          src = ./.;
          nativeBuildInputs = [
            pkgs.bun
            pkgs.nodejs_24
          ];
          buildPhase = ''
            runHook preBuild
            # The fixed-output cache contains dependencies only; source always
            # comes from this revision.
            cp -a ${bunDeps}/node_modules .
            for workspace in app packages/shared packages/ui; do
              if [ -d ${bunDeps}/$workspace/node_modules ]; then
                mkdir -p $workspace
                cp -a ${bunDeps}/$workspace/node_modules $workspace/
              fi
            done
            chmod -R u+w .
            patchShebangs node_modules
            mkdir -p data
            cp ${itemsData} data/items.json
            bun run build
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r app/dist $out/dist
            cp ${itemsData} $out/items.json
            cp scripts/render_item_report.py $out/render_item_report.py
            runHook postInstall
          '';
          meta.description = "xiv-market static site and item-data renderer";
        };

      # ops/universalis-proxy：Rust 版 Universalis 缓存反代，crane 负责 Cargo 依赖与编译。
      mkUniversalisProxy =
        pkgs:
        let
          craneLib = mkCraneLib pkgs;
          # 只把 Cargo 需要的文件收进源码，deploy/、README 改动不会触发重编译。
          src = craneLib.cleanCargoSource ./ops/universalis-proxy;
          commonArgs = {
            inherit src;
            strictDeps = true;
            # 依赖锁定在 crate 自己的 Cargo.lock，crane 据此 vendor 到离线目录。
            cargoLock = ./ops/universalis-proxy/Cargo.lock;
          };
          # 依赖单独编译一次，改 main.rs 时只重编自身。
          cargoArtifacts = craneLib.buildDepsOnly commonArgs;
        in
        craneLib.buildPackage (
          commonArgs
          // {
            inherit cargoArtifacts;
            # 仓库里没有测试，跳过 cargo test 以免再编一遍。
            doCheck = false;
            meta = {
              description = "Universalis caching reverse proxy for XIV Market";
              mainProgram = "universalis-proxy";
            };
          }
        );
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          market = mkPackage pkgs;
        in
        {
          default = market;
          xiv-market = market;
          universalis-proxy = mkUniversalisProxy pkgs;
        }
      );

      devShells = forAllSystems (pkgs: {
        # craneLib.devShell 自带同一套 rustc/cargo/clippy/rustfmt。
        default = (mkCraneLib pkgs).devShell {
          packages = with pkgs; [
            bun
            nodejs_24 # tsc / vite 需要 node 兼容运行时
            (python3.withPackages (ps: [ ps.requests ]))
          ];

          shellHook = ''
            echo "xiv-market dev shell"
            echo "  bun:   $(bun --version)"
            echo "  node:  $(node --version)"
            echo "  rustc: $(rustc --version)"
          '';
        };
      });
    };
}
