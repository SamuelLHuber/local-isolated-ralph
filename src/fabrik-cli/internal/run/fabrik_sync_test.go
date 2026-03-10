package run

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseSyncManifestRejectsForbiddenPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".fabrik-sync")
	if err := os.WriteFile(path, []byte(".git/config\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := parseSyncManifest(path)
	if err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("expected forbidden path error, got %v", err)
	}
}

func TestParseSyncManifestRejectsParentTraversal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".fabrik-sync")
	if err := os.WriteFile(path, []byte("../secret\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := parseSyncManifest(path)
	if err == nil || !strings.Contains(err.Error(), "parent path traversal") {
		t.Fatalf("expected parent traversal error, got %v", err)
	}
}

func TestResolveSyncBundleIncludesAllowedFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".fabrik-sync"), []byte(".env.local\nconfig/app.env\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".env.local"), []byte("A=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config", "app.env"), []byte("B=2\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	bundle, err := resolveSyncBundle(Options{FabrikSyncFile: filepath.Join(dir, ".fabrik-sync")})
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if bundle == nil {
		t.Fatalf("expected bundle")
	}
	if len(bundle.Files) != 2 {
		t.Fatalf("expected 2 files, got %d", len(bundle.Files))
	}
	if bundle.Files[0] != ".env.local" || bundle.Files[1] != "config/app.env" {
		t.Fatalf("unexpected file list: %v", bundle.Files)
	}

	names := unpackArchiveNames(t, bundle.ArchiveBase64)
	if !contains(names, ".env.local") || !contains(names, "config/app.env") {
		t.Fatalf("unexpected archive names: %v", names)
	}
}

func TestResolveSyncBundleRejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".fabrik-sync"), []byte("linked.env\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "real.env"), filepath.Join(dir, "linked.env")); err != nil {
		t.Fatal(err)
	}
	_, err := resolveSyncBundle(Options{FabrikSyncFile: filepath.Join(dir, ".fabrik-sync")})
	if err == nil || !strings.Contains(err.Error(), "symlinks are not allowed") {
		t.Fatalf("expected symlink error, got %v", err)
	}
}

func TestResolveSyncBundleRejectsLargeFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".fabrik-sync"), []byte("large.bin\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "large.bin"), bytes.Repeat([]byte("a"), maxFabrikSyncFileSize+1), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := resolveSyncBundle(Options{FabrikSyncFile: filepath.Join(dir, ".fabrik-sync")})
	if err == nil || !strings.Contains(err.Error(), "per-file limit") {
		t.Fatalf("expected size error, got %v", err)
	}
}

func TestResolveSyncBundleRejectsAbsolutePath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".fabrik-sync")
	if err := os.WriteFile(path, []byte("/tmp/secret.env\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := parseSyncManifest(path)
	if err == nil || !strings.Contains(err.Error(), "absolute paths are not allowed") {
		t.Fatalf("expected absolute path error, got %v", err)
	}
}

func TestResolveSyncBundleRejectsTotalSizeOverflow(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".fabrik-sync"), []byte("a.bin\nb.bin\nc.bin\nd.bin\ne.bin\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("a"), maxFabrikSyncTotal/4)
	for _, name := range []string{"a.bin", "b.bin", "c.bin", "d.bin", "e.bin"} {
		if err := os.WriteFile(filepath.Join(dir, name), chunk, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	_, err := resolveSyncBundle(Options{FabrikSyncFile: filepath.Join(dir, ".fabrik-sync")})
	if err == nil || !strings.Contains(err.Error(), "total limit") {
		t.Fatalf("expected total size error, got %v", err)
	}
}

func TestResolveSyncBundleRejectsDirectoryEntry(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".fabrik-sync"), []byte("app\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := resolveSyncBundle(Options{FabrikSyncFile: filepath.Join(dir, ".fabrik-sync")})
	if err == nil || !strings.Contains(err.Error(), "directories are not allowed") {
		t.Fatalf("expected directory rejection, got %v", err)
	}
}

func TestResolveSyncBundleRejectsForbiddenExplicitPath(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".fabrik-sync"), []byte(".jj\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := resolveSyncBundle(Options{FabrikSyncFile: filepath.Join(dir, ".fabrik-sync")})
	if err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("expected forbidden path error, got %v", err)
	}
}

func TestResolveSyncBundleRejectsNestedForbiddenPath(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".fabrik-sync"), []byte("app/.git/config\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := resolveSyncBundle(Options{FabrikSyncFile: filepath.Join(dir, ".fabrik-sync")})
	if err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("expected forbidden nested path error, got %v", err)
	}
}

func unpackArchiveNames(t *testing.T, archiveBase64 string) []string {
	t.Helper()
	payload, err := base64.StdEncoding.DecodeString(archiveBase64)
	if err != nil {
		t.Fatal(err)
	}
	gzr, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)
	var names []string
	for {
		hdr, err := tr.Next()
		if err != nil {
			if err == io.EOF {
				break
			}
			t.Fatal(err)
		}
		names = append(names, hdr.Name)
	}
	return names
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
