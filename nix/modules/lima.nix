# Lima guest support module
# Provides lima-init and lima-guestagent for VM integration with Lima
{ config, lib, pkgs, ... }:

with lib;

let
  cfg = config.services.lima-guest;

  limaInit = pkgs.writeShellScriptBin "lima-init" ''
    set -e
    LIMA_CIDATA=/mnt/lima-cidata

    if [[ ! -d "$LIMA_CIDATA" ]]; then
      echo "lima-init: No cidata found, skipping"
      exit 0
    fi

    # Read user data
    if [[ -f "$LIMA_CIDATA/user-data" ]]; then
      USER_DATA="$LIMA_CIDATA/user-data"
    else
      echo "lima-init: No user-data found"
      exit 0
    fi

    # Extract username from Lima's user-data (YAML)
    LIMA_USER=$(grep -A1 "^users:" "$USER_DATA" 2>/dev/null | grep "name:" | head -1 | sed 's/.*name: *//' || echo "")

    if [[ -z "$LIMA_USER" ]]; then
      echo "lima-init: Could not determine user from user-data"
      exit 0
    fi

    echo "lima-init: Setting up user $LIMA_USER"

    # Create user if it doesn't exist
    if ! id "$LIMA_USER" &>/dev/null; then
      useradd -m -G wheel,docker "$LIMA_USER" || true
    fi

    # Setup SSH keys from meta-data or user-data
    SSH_DIR="/home/$LIMA_USER/.ssh"
    mkdir -p "$SSH_DIR"

    # Lima puts SSH keys in meta-data
    if [[ -f "$LIMA_CIDATA/meta-data" ]]; then
      # Extract SSH keys (Lima format)
      grep -A100 "public-keys:" "$LIMA_CIDATA/meta-data" 2>/dev/null | \
        grep -E "^\s+-" | sed 's/^\s*- //' > "$SSH_DIR/authorized_keys" || true
    fi

    # Also check user-data for ssh_authorized_keys
    if [[ -f "$USER_DATA" ]]; then
      grep -A100 "ssh_authorized_keys:" "$USER_DATA" 2>/dev/null | \
        grep -E "^\s+-" | sed 's/^\s*- //' >> "$SSH_DIR/authorized_keys" || true
    fi

    chown -R "$LIMA_USER:$LIMA_USER" "$SSH_DIR"
    chmod 700 "$SSH_DIR"
    chmod 600 "$SSH_DIR/authorized_keys" 2>/dev/null || true

    echo "lima-init: Setup complete for $LIMA_USER"
  '';

in {
  options.services.lima-guest = {
    enable = mkEnableOption "Lima guest agent support";
  };

  config = mkIf cfg.enable {
    # Mount Lima's cidata
    fileSystems."/mnt/lima-cidata" = {
      device = "/dev/disk/by-label/cidata";
      fsType = "iso9660";
      options = [ "ro" "nofail" "noauto" "x-systemd.automount" ];
    };

    # Lima init service
    systemd.services.lima-init = {
      description = "Lima VM initialization";
      wantedBy = [ "multi-user.target" ];
      after = [ "local-fs.target" ];
      before = [ "sshd.service" ];

      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${limaInit}/bin/lima-init";
      };
    };

    # Lima guest agent (port forwarding)
    systemd.services.lima-guestagent = {
      description = "Lima guest agent";
      wantedBy = [ "multi-user.target" ];
      after = [ "lima-init.service" "network-online.target" ];
      wants = [ "network-online.target" ];

      serviceConfig = {
        Type = "simple";
        ExecStart = "${pkgs.lima}/share/lima/lima-guestagent daemon --vsock-port 2222";
        Restart = "always";
        RestartSec = "5s";
      };
    };

    # Packages needed for Lima integration
    environment.systemPackages = with pkgs; [
      lima
      sshfs
      fuse3
    ];

    # Enable vsock for VZ driver communication
    boot.kernelModules = [ "vsock" ];
  };
}
