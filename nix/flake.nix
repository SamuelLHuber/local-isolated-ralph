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
      # Support both architectures
      systems = [ "x86_64-linux" "aarch64-linux" ];

      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);

      # The core Ralph module - shared across all targets
      ralphModule = import ./modules/ralph.nix;

    in {
      # NixOS modules (importable by other flakes)
      nixosModules = {
        ralph = ralphModule;
        default = ralphModule;
      };

      # Ready-to-use NixOS configurations (for direct deployment, not generators)
      nixosConfigurations = {
        # Full NixOS VM/machine config (aarch64)
        ralph = nixpkgs.lib.nixosSystem {
          system = "aarch64-linux";
          modules = [
            ralphModule
            ./hosts/vm.nix
            # Boot configuration for standalone VM
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

        # x86_64 variant for cloud/Linux machines
        ralph-x86 = nixpkgs.lib.nixosSystem {
          system = "x86_64-linux";
          modules = [
            ralphModule
            ./hosts/vm.nix
            # Boot configuration for standalone VM
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

      # VM/Container images for different platforms
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in {
          # QCOW2 image for QEMU/Lima/libvirt
          qcow = nixos-generators.nixosGenerate {
            inherit system;
            format = "qcow";
            modules = [
              ralphModule
              ./hosts/vm.nix
            ];
          };

          # Raw disk image (works with Lima)
          raw = nixos-generators.nixosGenerate {
            inherit system;
            format = "raw";
            modules = [
              ralphModule
              ./hosts/vm.nix
            ];
          };

          # Docker image for k8s swarms
          docker = nixos-generators.nixosGenerate {
            inherit system;
            format = "docker";
            modules = [
              ralphModule
              ./hosts/container.nix
            ];
          };

          # ISO for bare metal installation
          iso = nixos-generators.nixosGenerate {
            inherit system;
            format = "iso";
            modules = [
              ralphModule
              ./hosts/vm.nix
            ];
          };

          # Amazon EC2 AMI
          amazon = nixos-generators.nixosGenerate {
            inherit system;
            format = "amazon";
            modules = [
              ralphModule
              ./hosts/cloud.nix
            ];
          };

          # Google Cloud image
          gce = nixos-generators.nixosGenerate {
            inherit system;
            format = "gce";
            modules = [
              ralphModule
              ./hosts/cloud.nix
            ];
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
