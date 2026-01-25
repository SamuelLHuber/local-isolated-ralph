# Lima guest support module
# Provides lima-init for SSH key setup when running under Lima
{ config, lib, pkgs, ... }:

with lib;

let
  cfg = config.services.lima-guest;

  # Use ralph user (defined in ralph.nix) - NixOS manages users declaratively
  targetUser = config.services.ralph.user or "ralph";

  limaInit = pkgs.writeShellScriptBin "lima-init" ''
    set -e
    LIMA_CIDATA=/mnt/lima-cidata
    TARGET_USER="${targetUser}"

    echo "lima-init: Starting initialization for user $TARGET_USER"

    if [[ ! -d "$LIMA_CIDATA" ]]; then
      echo "lima-init: No cidata found at $LIMA_CIDATA, skipping"
      exit 0
    fi

    # Setup SSH keys for the ralph user
    SSH_DIR="/home/$TARGET_USER/.ssh"
    mkdir -p "$SSH_DIR"

    # Clear any existing keys from cidata (keep manually added ones)
    touch "$SSH_DIR/authorized_keys"

    # Lima cloud-config format: ssh-authorized-keys under users section
    if [[ -f "$LIMA_CIDATA/user-data" ]]; then
      echo "lima-init: Reading SSH keys from user-data"
      # Extract SSH keys from cloud-config format (handles both ssh-authorized-keys and ssh_authorized_keys)
      # Keys are listed as "      - ssh-rsa ..." or "      - ssh-ed25519 ..."
      ${pkgs.gnugrep}/bin/grep -E '^\s+- "?ssh-' "$LIMA_CIDATA/user-data" 2>/dev/null | \
        ${pkgs.gnused}/bin/sed 's/^\s*- "//; s/"$//' >> "$SSH_DIR/authorized_keys" || true
    fi

    # Also check meta-data for public-keys (EC2-style format)
    if [[ -f "$LIMA_CIDATA/meta-data" ]]; then
      echo "lima-init: Reading SSH keys from meta-data"
      ${pkgs.gnugrep}/bin/grep -A100 "public-keys:" "$LIMA_CIDATA/meta-data" 2>/dev/null | \
        ${pkgs.gnugrep}/bin/grep -E '^\s+-' | ${pkgs.gnused}/bin/sed 's/^\s*- //' >> "$SSH_DIR/authorized_keys" || true
    fi

    # Deduplicate keys
    if [[ -f "$SSH_DIR/authorized_keys" ]]; then
      sort -u "$SSH_DIR/authorized_keys" > "$SSH_DIR/authorized_keys.tmp" && \
        mv "$SSH_DIR/authorized_keys.tmp" "$SSH_DIR/authorized_keys"
    fi

    # Fix ownership and permissions
    chown -R "$TARGET_USER:users" "$SSH_DIR"
    chmod 700 "$SSH_DIR"
    chmod 600 "$SSH_DIR/authorized_keys" 2>/dev/null || true

    KEY_COUNT=$(wc -l < "$SSH_DIR/authorized_keys" 2>/dev/null || echo 0)
    echo "lima-init: Setup complete - $KEY_COUNT SSH keys installed for $TARGET_USER"
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

    # Note: lima-guestagent is not included in nixpkgs lima package
    # Lima falls back to SSH port forwarding which works fine

    # Packages needed for Lima integration
    environment.systemPackages = with pkgs; [
      lima
      sshfs
      fuse3
    ];

  };
}
