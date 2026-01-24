# VM-specific configuration (Lima, QEMU, libvirt, etc.)
# Note: Boot/filesystem configured separately - see flake.nix for how this is used
{ config, lib, pkgs, modulesPath, ... }:

{
  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
  ];

  # Enable Ralph with full features
  services.ralph = {
    enable = true;
    browser.enable = true;
    browser.remoteDebugging = true;
    telemetry.enable = true;
    autonomousMode = true;
  };

  # VM optimizations
  boot.kernelParams = [ "console=ttyS0" ];

  # For Lima/Colima - optional mount for host directories
  fileSystems."/mnt/host" = {
    device = "mount0";
    fsType = "9p";
    options = [ "trans=virtio" "version=9p2000.L" "msize=104857600" "nofail" ];
    neededForBoot = false;
  };

  # Networking
  networking = {
    hostName = lib.mkDefault "ralph";
    useDHCP = true;
  };

  # Extra packages useful in VM context
  environment.systemPackages = with pkgs; [
    vim
    nano
    tree
    file
  ];

  system.stateVersion = "24.11";
}
