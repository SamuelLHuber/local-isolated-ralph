package run

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const workflowDispatchDir = "workflows"

var workflowImportPattern = regexp.MustCompile(`(?m)(?:import|export)\s+(?:[^"'` + "`" + `]+?\s+from\s+)?["'](\.[^"']+)["']`)

type WorkflowBundle struct {
	ArchiveBase64 string
	WorkdirPath   string
}

func resolveWorkflowBundle(workflowPath string) (*WorkflowBundle, error) {
	root := filepath.Dir(workflowPath)
	files, err := workflowBundleFiles(workflowPath, root)
	if err != nil {
		return nil, err
	}

	entries := make([]archiveEntry, 0, len(files))
	for _, rel := range files {
		entries = append(entries, archiveEntry{
			SourceRel:   rel,
			ArchivePath: filepath.ToSlash(filepath.Join(workflowDispatchDir, rel)),
		})
	}

	archive, err := buildArchive(root, entries)
	if err != nil {
		return nil, err
	}
	return &WorkflowBundle{
		ArchiveBase64: base64.StdEncoding.EncodeToString(archive),
		WorkdirPath:   filepath.ToSlash(filepath.Join(workflowDispatchDir, filepath.Base(workflowPath))),
	}, nil
}

func workflowBundleFiles(workflowPath, root string) ([]string, error) {
	root = filepath.Clean(root)
	entry, err := filepath.Rel(root, workflowPath)
	if err != nil {
		return nil, err
	}
	entry = filepath.Clean(entry)
	if entry == ".." || strings.HasPrefix(entry, ".."+string(filepath.Separator)) {
		return nil, fmt.Errorf("workflow %q must be under %s", workflowPath, root)
	}

	seen := map[string]struct{}{entry: {}}
	queue := []string{workflowPath}
	files := []string{entry}

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		imports, err := workflowRelativeImports(current)
		if err != nil {
			return nil, err
		}
		for _, path := range imports {
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return nil, err
			}
			rel = filepath.Clean(rel)
			if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return nil, fmt.Errorf("workflow %q imports %q outside its directory tree; keep dispatchable workflow support files under %s", workflowPath, path, root)
			}
			if _, ok := seen[rel]; ok {
				continue
			}
			seen[rel] = struct{}{}
			files = append(files, rel)
			queue = append(queue, path)
		}
	}

	sort.Strings(files[1:])
	return files, nil
}

func workflowRelativeImports(path string) ([]string, error) {
	data, err := osReadFile(path)
	if err != nil {
		return nil, err
	}

	var imports []string
	baseDir := filepath.Dir(path)
	for _, match := range workflowImportPattern.FindAllStringSubmatch(string(data), -1) {
		if len(match) < 2 {
			continue
		}
		resolved, err := resolveWorkflowImport(baseDir, match[1])
		if err != nil {
			return nil, fmt.Errorf("resolve workflow import %q from %s: %w", match[1], path, err)
		}
		imports = append(imports, resolved)
	}
	return imports, nil
}

func resolveWorkflowImport(baseDir, spec string) (string, error) {
	candidate := filepath.Clean(filepath.Join(baseDir, filepath.FromSlash(spec)))
	candidates := []string{candidate}
	for _, ext := range []string{".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"} {
		candidates = append(candidates, candidate+ext)
	}
	for _, ext := range []string{".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"} {
		candidates = append(candidates, filepath.Join(candidate, "index"+ext))
	}
	for _, path := range candidates {
		if fileExists(path) {
			return path, nil
		}
	}
	return "", fmt.Errorf("no local file found")
}

var osReadFile = func(path string) ([]byte, error) {
	return os.ReadFile(path)
}

var fileExists = func(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
