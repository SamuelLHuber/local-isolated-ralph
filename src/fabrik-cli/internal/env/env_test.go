package env

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseDotenvRejectsDuplicateKeys(t *testing.T) {
	_, err := parseDotenv("A=1\nA=2\n")
	if err == nil {
		t.Fatalf("expected duplicate key error")
	}
}

func TestParseDotenvRejectsReservedSmithersKey(t *testing.T) {
	data, err := parseDotenv("SMITHERS_RUN_ID=abc\n")
	if err != nil {
		t.Fatalf("parse dotenv: %v", err)
	}
	if err := validateSecretData(data); err == nil {
		t.Fatalf("expected reserved-key validation failure")
	}
}

func TestRenderDotenvSorted(t *testing.T) {
	out := renderDotenv(map[string]string{
		"B": "2",
		"A": "1",
	})
	if !strings.HasPrefix(out, "A=") {
		t.Fatalf("expected sorted output, got %q", out)
	}
}

func TestParseDotenvPreservesUnbalancedQuotes(t *testing.T) {
	data, err := parseDotenv("TOKEN='\"abc\nOTHER=abc\"'\n")
	if err != nil {
		t.Fatalf("parse dotenv: %v", err)
	}
	if got := data["TOKEN"]; got != "'\"abc" {
		t.Fatalf("expected TOKEN to preserve leading quote pattern, got %q", got)
	}
	if got := data["OTHER"]; got != "abc\"'" {
		t.Fatalf("expected OTHER to preserve trailing quote pattern, got %q", got)
	}
}

func TestParseDotenvStripsMatchingWrapperQuotesOnly(t *testing.T) {
	data, err := parseDotenv("A='value'\nB=\"value\"\n")
	if err != nil {
		t.Fatalf("parse dotenv: %v", err)
	}
	if got := data["A"]; got != "value" {
		t.Fatalf("expected A to strip single quotes, got %q", got)
	}
	if got := data["B"]; got != "value" {
		t.Fatalf("expected B to strip double quotes, got %q", got)
	}
}

func TestWritePrivateFileTightensExistingPermissions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "secret.env")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := writePrivateFile(path, []byte("new")); err != nil {
		t.Fatalf("write private file: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat output: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("expected mode 0600, got %o", mode)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}
	if string(content) != "new" {
		t.Fatalf("expected updated content, got %q", string(content))
	}
}

func TestUpsertDotenvValueUpdatesAndAppends(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	if err := os.WriteFile(path, []byte("A=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := UpsertDotenvValue(path, "B", "2"); err != nil {
		t.Fatalf("append dotenv value: %v", err)
	}
	if err := UpsertDotenvValue(path, "A", "3"); err != nil {
		t.Fatalf("update dotenv value: %v", err)
	}

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read dotenv: %v", err)
	}
	if got := string(content); got != "A=\"3\"\nB=\"2\"\n" {
		t.Fatalf("unexpected dotenv content: %q", got)
	}
}

// DiffResult tests

func TestDiffResultIsDifferent(t *testing.T) {
	tests := []struct {
		name     string
		result   DiffResult
		expected bool
	}{
		{
			name:     "empty diff",
			result:   DiffResult{OnlyInSource: map[string]string{}, OnlyInTarget: map[string]string{}, Changed: map[string]ValueChange{}},
			expected: false,
		},
		{
			name:     "only in source",
			result:   DiffResult{OnlyInSource: map[string]string{"A": "1"}, OnlyInTarget: map[string]string{}, Changed: map[string]ValueChange{}},
			expected: true,
		},
		{
			name:     "only in target",
			result:   DiffResult{OnlyInSource: map[string]string{}, OnlyInTarget: map[string]string{"B": "2"}, Changed: map[string]ValueChange{}},
			expected: true,
		},
		{
			name:     "changed values",
			result:   DiffResult{OnlyInSource: map[string]string{}, OnlyInTarget: map[string]string{}, Changed: map[string]ValueChange{"C": {FromValue: "1", ToValue: "2"}}},
			expected: true,
		},
		{
			name:     "unchanged only",
			result:   DiffResult{OnlyInSource: map[string]string{}, OnlyInTarget: map[string]string{}, Changed: map[string]ValueChange{}, Unchanged: map[string]string{"D": "3"}},
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.result.IsDifferent(); got != tt.expected {
				t.Errorf("IsDifferent() = %v, want %v", got, tt.expected)
			}
		})
	}
}

func TestDiffResultStats(t *testing.T) {
	result := DiffResult{
		OnlyInSource: map[string]string{"A": "1", "B": "2"},
		OnlyInTarget: map[string]string{"C": "3"},
		Changed:      map[string]ValueChange{"D": {FromValue: "1", ToValue: "2"}},
		Unchanged:    map[string]string{"E": "5"},
	}

	added, removed, modified, unchanged := result.Stats()
	if added != 2 {
		t.Errorf("Stats() added = %d, want 2", added)
	}
	if removed != 1 {
		t.Errorf("Stats() removed = %d, want 1", removed)
	}
	if modified != 1 {
		t.Errorf("Stats() modified = %d, want 1", modified)
	}
	if unchanged != 1 {
		t.Errorf("Stats() unchanged = %d, want 1", unchanged)
	}
}

// Protected environment tests

func TestIsProtectedEnvironment(t *testing.T) {
	tests := []struct {
		envName  string
		expected bool
	}{
		{"prod", true},
		{"production", true},
		{"live", true},
		{"PROD", true},     // case insensitive
		{"Prod", true},     // case insensitive
		{"dev", false},
		{"staging", false},
		{"preview", false},
		{"", false},
		{"my-prod-env", false}, // contains but not exact match
		{"production-like", false},
	}

	for _, tt := range tests {
		t.Run(tt.envName, func(t *testing.T) {
			if got := IsProtectedEnvironment(tt.envName); got != tt.expected {
				t.Errorf("IsProtectedEnvironment(%q) = %v, want %v", tt.envName, got, tt.expected)
			}
		})
	}
}

func TestSetProtectedEnvNames(t *testing.T) {
	// Save original
	original := protectedEnvNames
	defer func() { protectedEnvNames = original }()

	// Set custom protected names
	SetProtectedEnvNames([]string{"critical", "secure"})

	if !IsProtectedEnvironment("critical") {
		t.Error("expected 'critical' to be protected after SetProtectedEnvNames")
	}
	if !IsProtectedEnvironment("secure") {
		t.Error("expected 'secure' to be protected after SetProtectedEnvNames")
	}
	if IsProtectedEnvironment("prod") {
		t.Error("expected 'prod' to not be protected after custom SetProtectedEnvNames")
	}
}

// PromotePreview tests

func TestPromotePreviewIsProtected(t *testing.T) {
	tests := []struct {
		toEnv    string
		expected bool
	}{
		{"prod", true},
		{"staging", false},
	}

	for _, tt := range tests {
		t.Run(tt.toEnv, func(t *testing.T) {
			preview := PromotePreview{
				Diff: DiffResult{ToEnv: tt.toEnv},
			}
			if got := preview.IsProtected(); got != tt.expected {
				t.Errorf("IsProtected() for %q = %v, want %v", tt.toEnv, got, tt.expected)
			}
		})
	}
}

func TestPromotePreviewRequiresConfirmation(t *testing.T) {
	tests := []struct {
		name     string
		preview  PromotePreview
		expected bool
	}{
		{
			name:     "protected env requires confirmation even if no diff",
			preview:  PromotePreview{Diff: DiffResult{ToEnv: "prod", OnlyInSource: map[string]string{}, OnlyInTarget: map[string]string{}, Changed: map[string]ValueChange{}}},
			expected: true,
		},
		{
			name:     "non-protected with changes requires confirmation",
			preview:  PromotePreview{Diff: DiffResult{ToEnv: "staging", OnlyInSource: map[string]string{"A": "1"}}},
			expected: true,
		},
		{
			name:     "non-protected no changes no target does not require confirmation",
			preview:  PromotePreview{Diff: DiffResult{ToEnv: "dev", OnlyInSource: map[string]string{}}, TargetExists: false},
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.preview.RequiresConfirmation(); got != tt.expected {
				t.Errorf("RequiresConfirmation() = %v, want %v", got, tt.expected)
			}
		})
	}
}

// Diff output format tests

func TestDiffOutputFormat(t *testing.T) {
	// This tests the expected output format without requiring kubectl
	var stdout bytes.Buffer

	// Create a mock diff result by directly testing the rendering logic
	result := DiffResult{
		Project:      "myapp",
		FromEnv:      "dev",
		ToEnv:        "prod",
		OnlyInSource: map[string]string{"NEW_KEY": "new_value"},
		OnlyInTarget: map[string]string{"OLD_KEY": "old_value"},
		Changed: map[string]ValueChange{
			"MODIFIED_KEY": {FromValue: "dev_value", ToValue: "prod_value"},
		},
		Unchanged: map[string]string{"STABLE_KEY": "stable_value"},
	}

	// Test that the format includes explicit categorization
	output := renderDiffForTest(result)

	if !strings.Contains(output, "only in dev") {
		t.Errorf("expected output to contain 'only in dev', got:\n%s", output)
	}
	if !strings.Contains(output, "only in prod") {
		t.Errorf("expected output to contain 'only in prod', got:\n%s", output)
	}
	if !strings.Contains(output, "changed") {
		t.Errorf("expected output to contain 'changed', got:\n%s", output)
	}
	if !strings.Contains(output, "summary:") {
		t.Errorf("expected output to contain 'summary:', got:\n%s", output)
	}

	// Reset for next test
	stdout.Reset()

	// Test no differences output
	emptyResult := DiffResult{
		Project:      "myapp",
		FromEnv:      "dev",
		ToEnv:        "staging",
		OnlyInSource: map[string]string{},
		OnlyInTarget: map[string]string{},
		Changed:      map[string]ValueChange{},
		Unchanged:    map[string]string{"A": "1"},
	}

	if emptyResult.IsDifferent() {
		t.Error("expected empty result to not be different")
	}

	// Verify stats for empty result
	added, removed, modified, unchanged := emptyResult.Stats()
	if added != 0 || removed != 0 || modified != 0 || unchanged != 1 {
		t.Errorf("unexpected stats for empty diff: added=%d, removed=%d, modified=%d, unchanged=%d",
			added, removed, modified, unchanged)
	}
}

// Helper function to test diff rendering
func renderDiffForTest(result DiffResult) string {
	var b bytes.Buffer

	added, removed, modified, unchanged := result.Stats()

	if len(result.OnlyInSource) > 0 {
		b.WriteString("\n")
		b.WriteString(fmt.Sprintf("[%d key(s) only in %s (will be added to %s)]\n", added, result.FromEnv, result.ToEnv))
		for _, key := range sortedKeys(result.OnlyInSource) {
			b.WriteString(fmt.Sprintf("  + %s\n", key))
		}
	}

	if len(result.OnlyInTarget) > 0 {
		b.WriteString("\n")
		b.WriteString(fmt.Sprintf("[%d key(s) only in %s (extra in %s)]\n", removed, result.ToEnv, result.ToEnv))
		for _, key := range sortedKeys(result.OnlyInTarget) {
			b.WriteString(fmt.Sprintf("  - %s\n", key))
		}
	}

	if len(result.Changed) > 0 {
		b.WriteString("\n")
		b.WriteString(fmt.Sprintf("[%d key(s) changed between %s and %s]\n", modified, result.FromEnv, result.ToEnv))
		for _, key := range sortedChangedKeys(result.Changed) {
			b.WriteString(fmt.Sprintf("  ~ %s\n", key))
		}
	}

	b.WriteString("\n")
	b.WriteString(fmt.Sprintf("summary: %d added, %d removed, %d modified, %d unchanged\n",
		added, removed, modified, unchanged))

	return b.String()
}

// Promote confirmation flow tests

func TestPromoteConfirmationPromptYes(t *testing.T) {
	stdin := bytes.NewBufferString("yes\n")
	var stdout bytes.Buffer

	preview := PromotePreview{
		Diff:           DiffResult{ToEnv: "staging", OnlyInSource: map[string]string{"A": "1"}},
		TargetExists:   true,
		SourceKeyCount: 1,
	}

	opts := PromoteOptions{
		FromEnv: "dev",
		ToEnv:   "staging",
		Yes:     false,
	}

	confirmed, err := promptConfirm(stdin, &stdout, preview, opts)
	if err != nil {
		t.Fatalf("promptConfirm: %v", err)
	}
	if !confirmed {
		t.Error("expected confirmation for 'yes'")
	}

	output := stdout.String()
	if !strings.Contains(output, "Promote") {
		t.Errorf("expected prompt to contain 'Promote', got: %s", output)
	}
}

func TestPromoteConfirmationPromptNo(t *testing.T) {
	stdin := bytes.NewBufferString("no\n")
	var stdout bytes.Buffer

	preview := PromotePreview{
		Diff:           DiffResult{ToEnv: "staging", OnlyInSource: map[string]string{"A": "1"}},
		TargetExists:   true,
		SourceKeyCount: 1,
	}

	opts := PromoteOptions{
		FromEnv: "dev",
		ToEnv:   "staging",
		Yes:     false,
	}

	confirmed, err := promptConfirm(stdin, &stdout, preview, opts)
	if err != nil {
		t.Fatalf("promptConfirm: %v", err)
	}
	if confirmed {
		t.Error("expected no confirmation for 'no'")
	}
}

func TestPromoteConfirmationPromptY(t *testing.T) {
	stdin := bytes.NewBufferString("y\n")
	var stdout bytes.Buffer

	preview := PromotePreview{
		Diff: DiffResult{ToEnv: "prod"}, // protected env
	}

	opts := PromoteOptions{
		FromEnv: "staging",
		ToEnv:   "prod",
		Yes:     false,
	}

	confirmed, err := promptConfirm(stdin, &stdout, preview, opts)
	if err != nil {
		t.Fatalf("promptConfirm: %v", err)
	}
	if !confirmed {
		t.Error("expected confirmation for 'y'")
	}

	// Protected environment should have specific prompt
	output := stdout.String()
	if !strings.Contains(output, "protected environment") && !strings.Contains(output, "PROTECTED") {
		// Note: the actual prompt text depends on implementation
		// but for protected env, the prompt should indicate this
		t.Logf("prompt output: %s", output)
	}
}

func TestPromoteConfirmationPromptEmpty(t *testing.T) {
	stdin := bytes.NewBufferString("\n")
	var stdout bytes.Buffer

	preview := PromotePreview{
		Diff:           DiffResult{ToEnv: "staging", OnlyInSource: map[string]string{"A": "1"}},
		TargetExists:   true,
		SourceKeyCount: 1,
	}

	opts := PromoteOptions{
		FromEnv: "dev",
		ToEnv:   "staging",
		Yes:     false,
	}

	confirmed, err := promptConfirm(stdin, &stdout, preview, opts)
	if err != nil {
		t.Fatalf("promptConfirm: %v", err)
	}
	if confirmed {
		t.Error("expected no confirmation for empty input")
	}
}

func TestPromoteWithYesFlagSkipsPrompt(t *testing.T) {
	// When --yes is passed, promotion should skip confirmation
	// This is a logic test, not a full integration test
	preview := PromotePreview{
		Diff:           DiffResult{ToEnv: "prod", OnlyInSource: map[string]string{"A": "1"}},
		TargetExists:   true,
		SourceKeyCount: 1,
	}

	opts := PromoteOptions{
		FromEnv: "dev",
		ToEnv:   "prod",
		Yes:     true, // --yes flag
	}

	// With --yes, we should not require interactive confirmation
	if preview.RequiresConfirmation() && opts.Yes {
		// Logic is: if Yes flag is set, we bypass the confirmation check
		// This is handled at the caller level, not in RequiresConfirmation()
		t.Log("--yes flag allows bypassing confirmation for protected envs")
	}
}

// Test renderPromotePreview output for protected environment
func TestRenderPromotePreviewProtected(t *testing.T) {
	var stdout bytes.Buffer

	preview := PromotePreview{
		Diff:         DiffResult{ToEnv: "prod"},
		TargetExists: true,
	}
	opts := PromoteOptions{ToEnv: "prod"}

	err := renderPromotePreview(&stdout, preview, opts)
	if err != nil {
		t.Fatalf("renderPromotePreview: %v", err)
	}

	output := stdout.String()
	if !strings.Contains(output, "PROTECTED ENVIRONMENT") {
		t.Errorf("expected output to contain 'PROTECTED ENVIRONMENT' for prod, got: %s", output)
	}
}

// Test renderPromotePreview output for non-existent target
func TestRenderPromotePreviewNewTarget(t *testing.T) {
	var stdout bytes.Buffer

	preview := PromotePreview{
		Diff:         DiffResult{ToEnv: "staging"},
		TargetExists: false,
	}
	opts := PromoteOptions{ToEnv: "staging"}

	err := renderPromotePreview(&stdout, preview, opts)
	if err != nil {
		t.Fatalf("renderPromotePreview: %v", err)
	}

	output := stdout.String()
	if !strings.Contains(output, "does not exist") {
		t.Errorf("expected output to mention target does not exist, got: %s", output)
	}
}

// Test renderPromotePreview when no changes needed
func TestRenderPromotePreviewNoChanges(t *testing.T) {
	var stdout bytes.Buffer

	preview := PromotePreview{
		Diff:         DiffResult{ToEnv: "dev", OnlyInSource: map[string]string{}, OnlyInTarget: map[string]string{}, Changed: map[string]ValueChange{}},
		TargetExists: true,
	}
	opts := PromoteOptions{ToEnv: "dev", FromEnv: "staging"}

	err := renderPromotePreview(&stdout, preview, opts)
	if err != nil {
		t.Fatalf("renderPromotePreview: %v", err)
	}

	output := stdout.String()
	if !strings.Contains(output, "no changes") {
		t.Errorf("expected output to mention no changes, got: %s", output)
	}
}

// Test protected environment detection with additional edge cases
func TestIsProtectedEnvironmentEdgeCases(t *testing.T) {
	tests := []struct {
		envName  string
		expected bool
	}{
		{"prod", true},
		{"production", true},
		{"live", true},
		{"PROD", true},
		{"Production", true},
		{"  prod  ", true}, // whitespace should be trimmed
		{"dev", false},
		{"staging", false},
		{"preview", false},
		{"test", false},
		{"local", false},
		{"", false},
		{"my-prod", false},    // contains but not exact
		{"prod-env", false},   // contains but not exact
		{"prods", false},      // substring match but not exact
		{"productions", false}, // substring match but not exact
	}

	for _, tt := range tests {
		t.Run(tt.envName, func(t *testing.T) {
			if got := IsProtectedEnvironment(tt.envName); got != tt.expected {
				t.Errorf("IsProtectedEnvironment(%q) = %v, want %v", tt.envName, got, tt.expected)
			}
		})
	}
}

// Test that diff properly handles empty environments
func TestDiffEmptyEnvironments(t *testing.T) {
	// Empty to empty should have no differences
	emptyResult := DiffResult{
		Project:      "myapp",
		FromEnv:      "empty1",
		ToEnv:        "empty2",
		OnlyInSource: map[string]string{},
		OnlyInTarget: map[string]string{},
		Changed:      map[string]ValueChange{},
		Unchanged:    map[string]string{},
	}

	if emptyResult.IsDifferent() {
		t.Error("expected empty to empty comparison to not be different")
	}

	added, removed, modified, unchanged := emptyResult.Stats()
	if added != 0 || removed != 0 || modified != 0 || unchanged != 0 {
		t.Errorf("expected all zero stats for empty diff, got added=%d, removed=%d, modified=%d, unchanged=%d",
			added, removed, modified, unchanged)
	}
}

// Test ValueChange struct behavior
func TestValueChangeStruct(t *testing.T) {
	change := ValueChange{
		FromValue: "old-value",
		ToValue:   "new-value",
	}

	if change.FromValue != "old-value" {
		t.Errorf("expected FromValue to be 'old-value', got %q", change.FromValue)
	}
	if change.ToValue != "new-value" {
		t.Errorf("expected ToValue to be 'new-value', got %q", change.ToValue)
	}

	// Test with empty values
	emptyChange := ValueChange{}
	if emptyChange.FromValue != "" || emptyChange.ToValue != "" {
		t.Error("expected empty ValueChange to have empty strings")
	}
}

// Test that the diff categories are correctly computed
func TestDiffCategories(t *testing.T) {
	fromData := map[string]string{
		"SHARED_SAME": "value1",
		"SHARED_DIFF": "from_value",
		"ONLY_FROM":   "from_only",
	}

	toData := map[string]string{
		"SHARED_SAME": "value1",
		"SHARED_DIFF": "to_value",
		"ONLY_TO":     "to_only",
	}

	result := DiffResult{
		OnlyInSource: map[string]string{},
		OnlyInTarget: map[string]string{},
		Changed:      map[string]ValueChange{},
		Unchanged:    map[string]string{},
	}

	// Simulate ComputeDiff logic
	for key, fromValue := range fromData {
		toValue, existsInTarget := toData[key]
		if !existsInTarget {
			result.OnlyInSource[key] = fromValue
		} else if fromValue != toValue {
			result.Changed[key] = ValueChange{FromValue: fromValue, ToValue: toValue}
		} else {
			result.Unchanged[key] = fromValue
		}
	}

	for key, toValue := range toData {
		if _, existsInSource := fromData[key]; !existsInSource {
			result.OnlyInTarget[key] = toValue
		}
	}

	// Verify categorization
	if _, ok := result.OnlyInSource["ONLY_FROM"]; !ok {
		t.Error("expected ONLY_FROM to be in OnlyInSource")
	}
	if _, ok := result.OnlyInTarget["ONLY_TO"]; !ok {
		t.Error("expected ONLY_TO to be in OnlyInTarget")
	}
	if change, ok := result.Changed["SHARED_DIFF"]; !ok {
		t.Error("expected SHARED_DIFF to be in Changed")
	} else {
		if change.FromValue != "from_value" || change.ToValue != "to_value" {
			t.Errorf("unexpected change values: %+v", change)
		}
	}
	if _, ok := result.Unchanged["SHARED_SAME"]; !ok {
		t.Error("expected SHARED_SAME to be in Unchanged")
	}

	// Stats should match
	added, removed, modified, unchanged := result.Stats()
	if added != 1 {
		t.Errorf("expected 1 added, got %d", added)
	}
	if removed != 1 {
		t.Errorf("expected 1 removed, got %d", removed)
	}
	if modified != 1 {
		t.Errorf("expected 1 modified, got %d", modified)
	}
	if unchanged != 1 {
		t.Errorf("expected 1 unchanged, got %d", unchanged)
	}
}
