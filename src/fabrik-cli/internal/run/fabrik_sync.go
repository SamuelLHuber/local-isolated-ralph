package run

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultFabrikSyncFile = ".fabrik-sync"
	maxFabrikSyncFileSize = 256 * 1024
	maxFabrikSyncTotal    = 1024 * 1024
)

var forbiddenSyncPathParts = map[string]struct{}{
	".git":         {},
	".jj":          {},
	"node_modules": {},
	".next":        {},
	"dist":         {},
	"build":        {},
}

type SyncBundle struct {
	ManifestPath  string
	ArchiveBase64 string
	Files         []string
}

func resolveSyncBundle(opts Options) (*SyncBundle, error) {
	manifestPath := strings.TrimSpace(opts.FabrikSyncFile)
	if manifestPath == "" {
		manifestPath = defaultFabrikSyncFile
	}

	resolvedPath, err := resolveLocalPath(manifestPath)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(resolvedPath); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to read fabrik sync manifest %q: %w", resolvedPath, err)
	}

	entries, err := parseSyncManifest(resolvedPath)
	if err != nil {
		return nil, err
	}

	baseDir := filepath.Dir(resolvedPath)
	files, err := collectSyncFiles(baseDir, entries)
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, nil
	}

	archive, err := buildSyncArchive(baseDir, files)
	if err != nil {
		return nil, err
	}

	return &SyncBundle{
		ManifestPath:  resolvedPath,
		ArchiveBase64: base64.StdEncoding.EncodeToString(archive),
		Files:         files,
	}, nil
}

func parseSyncManifest(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var entries []string
	for lineNo, raw := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if filepath.IsAbs(line) {
			return nil, fmt.Errorf("%s:%d: absolute paths are not allowed in .fabrik-sync", path, lineNo+1)
		}
		clean := filepath.Clean(filepath.FromSlash(line))
		if clean == "." {
			continue
		}
		if strings.HasPrefix(clean, ".."+string(filepath.Separator)) || clean == ".." {
			return nil, fmt.Errorf("%s:%d: parent path traversal is not allowed in .fabrik-sync", path, lineNo+1)
		}
		if err := validateSyncRelativePath(clean); err != nil {
			return nil, fmt.Errorf("%s:%d: %w", path, lineNo+1, err)
		}
		entries = append(entries, clean)
	}
	return entries, nil
}

func collectSyncFiles(baseDir string, entries []string) ([]string, error) {
	seen := map[string]struct{}{}
	var files []string

	for _, entry := range entries {
		absPath := filepath.Join(baseDir, entry)
		info, err := os.Lstat(absPath)
		if err != nil {
			return nil, fmt.Errorf("failed to stat %q from .fabrik-sync: %w", entry, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("symlinks are not allowed in .fabrik-sync: %s", entry)
		}
		if info.IsDir() {
			return nil, fmt.Errorf("directories are not allowed in .fabrik-sync: %s", entry)
		}
		if _, ok := seen[entry]; !ok {
			files = append(files, entry)
			seen[entry] = struct{}{}
		}
	}

	return files, nil
}

func validateSyncRelativePath(path string) error {
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		if _, forbidden := forbiddenSyncPathParts[part]; forbidden {
			return fmt.Errorf("path %q is forbidden in .fabrik-sync", path)
		}
	}
	return nil
}

func buildSyncArchive(baseDir string, files []string) ([]byte, error) {
	entries := make([]archiveEntry, 0, len(files))
	for _, rel := range files {
		entries = append(entries, archiveEntry{
			SourceRel:   rel,
			ArchivePath: rel,
		})
	}
	return buildArchive(baseDir, entries)
}

type archiveEntry struct {
	SourceRel   string
	ArchivePath string
}

func buildArchive(baseDir string, entries []archiveEntry) ([]byte, error) {
	var totalSize int64
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	tarWriter := tar.NewWriter(gzipWriter)

	for _, entry := range entries {
		abs := filepath.Join(baseDir, entry.SourceRel)
		info, err := os.Lstat(abs)
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("symlinks are not allowed in .fabrik-sync: %s", entry.SourceRel)
		}
		if info.Size() > maxFabrikSyncFileSize {
			return nil, fmt.Errorf("file %q exceeds .fabrik-sync per-file limit of %d bytes", entry.SourceRel, maxFabrikSyncFileSize)
		}
		totalSize += info.Size()
		if totalSize > maxFabrikSyncTotal {
			return nil, fmt.Errorf(".fabrik-sync content exceeds total limit of %d bytes", maxFabrikSyncTotal)
		}

		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return nil, err
		}
		header.Name = filepath.ToSlash(entry.ArchivePath)
		if err := tarWriter.WriteHeader(header); err != nil {
			return nil, err
		}

		file, err := os.Open(abs)
		if err != nil {
			return nil, err
		}
		if _, err := io.Copy(tarWriter, file); err != nil {
			_ = file.Close()
			return nil, err
		}
		if err := file.Close(); err != nil {
			return nil, err
		}
	}

	if err := tarWriter.Close(); err != nil {
		return nil, err
	}
	if err := gzipWriter.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}
