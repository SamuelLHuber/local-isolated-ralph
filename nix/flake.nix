{
  description = "Ralph - Isolated coding agent environment";

  inputs = {
    # Use 24.11 for better compatibility with nixos-generators
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    # For generating different image formats
    nixos-generators = {
      url = "github:nix-community/nixos-generators";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nixpkgs-unstable, nixos-generators, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];

      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);

      # Overlay to use jujutsu from unstable (24.11 version is marked insecure)
      jujutsuOverlay = final: prev: {
        jujutsu = nixpkgs-unstable.legacyPackages.${prev.system}.jujutsu;
      };

      ralphModule = import ./modules/ralph.nix;

    in {
      # NixOS modules (importable by other flakes)
      nixosModules = {
        ralph = ralphModule;
        default = ralphModule;
      };

      nixosConfigurations = {
        ralph = nixpkgs.lib.nixosSystem {
          system = "aarch64-linux";
          modules = [
            { nixpkgs.overlays = [ jujutsuOverlay ]; }
            ralphModule
            ./hosts/vm.nix
            {
              boot.loader.grub.enable = true;
              boot.loader.grub.device = "/dev/vda";
              fileSystems."/" = {
                device = "/dev/vda1";
                fsType = "ext4";
              };
            }
          ];
        };

        ralph-x86 = nixpkgs.lib.nixosSystem {
          system = "x86_64-linux";
          modules = [
            { nixpkgs.overlays = [ jujutsuOverlay ]; }
            ralphModule
            ./hosts/vm.nix
            {
              boot.loader.grub.enable = true;
              boot.loader.grub.device = "/dev/vda";
              fileSystems."/" = {
                device = "/dev/vda1";
                fsType = "ext4";
              };
            }
          ];
        };
      };

      packages = forAllSystems (system:
        let
          overlayModule = { nixpkgs.overlays = [ jujutsuOverlay ]; };
        in {
          qcow = nixos-generators.nixosGenerate {
            inherit system;
            format = "qcow";
            modules = [ overlayModule ralphModule ./hosts/vm.nix ];
          };

          raw = nixos-generators.nixosGenerate {
            inherit system;
            format = "raw";
            modules = [ overlayModule ralphModule ./hosts/vm.nix ];
          };

          docker = nixos-generators.nixosGenerate {
            inherit system;
            format = "docker";
            modules = [ overlayModule ralphModule ./hosts/container.nix ];
          };

          iso = nixos-generators.nixosGenerate {
            inherit system;
            format = "iso";
            modules = [ overlayModule ralphModule ./hosts/vm.nix ];
          };

          amazon = nixos-generators.nixosGenerate {
            inherit system;
            format = "amazon";
            modules = [ overlayModule ralphModule ./hosts/cloud.nix ];
          };

          gce = nixos-generators.nixosGenerate {
            inherit system;
            format = "gce";
            modules = [ overlayModule ralphModule ./hosts/cloud.nix ];
          };
        }
      );

      # Development shell for working on Ralph configs
      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nixos-generators
              lima
              qemu
            ];
          };
        }
      );
    };
}
