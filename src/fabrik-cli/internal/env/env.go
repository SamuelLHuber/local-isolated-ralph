package env

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

type Options struct {
	Project   string
	Env       string
	Namespace string
	Context   string
}

type SetOptions struct {
	Options
	FromFile string
	Replace  bool
	Unset    []string
	Pairs    []string
}

type PullOptions struct {
	Options
	OutputPath string
}

type DiffOptions struct {
	Project string
	FromEnv string
	ToEnv   string
	Options
}

type PromoteOptions struct {
	Project string
	FromEnv string
	ToEnv   string
	Replace bool
	Options
}

type secretResponse struct {
	Data map[string]string `json:"data"`
}

func ValidateOptions(opts Options) error {
	if strings.TrimSpace(opts.Project) == "" {
		return errors.New("missing required flag: --project")
	}
	if err := validateIdentifier("project", opts.Project); err != nil {
		return err
	}
	if strings.TrimSpace(opts.Env) == "" {
		return errors.New("missing required flag: --env")
	}
	if err := validateIdentifier("environment", opts.Env); err != nil {
		return err
	}
	if strings.TrimSpace(opts.Namespace) == "" {
		return errors.New("missing required flag: --namespace")
	}
	return nil
}

func SecretName(project, envName string) string {
	return fmt.Sprintf("fabrik-env-%s-%s", sanitizeIdentifier(project), sanitizeIdentifier(envName))
}

func List(ctx context.Context, stdout io.Writer, opts Options) error {
	data, err := GetSecretData(ctx, opts)
	if err != nil {
		return err
	}

	keys := sortedKeys(data)
	if len(keys) == 0 {
		_, err := fmt.Fprintf(stdout, "%s: no keys\n", SecretName(opts.Project, opts.Env))
		return err
	}

	if _, err := fmt.Fprintf(stdout, "%s\n", SecretName(opts.Project, opts.Env)); err != nil {
		return err
	}
	for _, key := range keys {
		if _, err := fmt.Fprintf(stdout, "%s\n", key); err != nil {
			return err
		}
	}
	return nil
}

func Pull(ctx context.Context, stdout io.Writer, opts PullOptions) error {
	data, err := GetSecretData(ctx, opts.Options)
	if err != nil {
		return err
	}
	content := renderDotenv(data)
	if strings.TrimSpace(opts.OutputPath) == "" {
		_, err := io.WriteString(stdout, content)
		return err
	}
	return os.WriteFile(opts.OutputPath, []byte(content), 0o600)
}

func Validate(ctx context.Context, stdout io.Writer, opts Options) error {
	data, err := GetSecretData(ctx, opts)
	if err != nil {
		return err
	}
	if err := validateSecretData(data); err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "%s valid (%d key(s))\n", SecretName(opts.Project, opts.Env), len(data))
	return err
}

func Set(ctx context.Context, stdout io.Writer, opts SetOptions) error {
	if err := ValidateOptions(opts.Options); err != nil {
		return err
	}

	current := map[string]string{}
	if !opts.Replace {
		existing, err := GetSecretData(ctx, opts.Options)
		if err != nil && !IsSecretNotFound(err) {
			return err
		}
		if err == nil {
			current = existing
		}
	}

	fileData, err := parseDotenvFile(opts.FromFile)
	if err != nil {
		return err
	}
	for key, value := range fileData {
		current[key] = value
	}

	inlineData, err := parseInlinePairs(opts.Pairs)
	if err != nil {
		return err
	}
	for key, value := range inlineData {
		current[key] = value
	}

	for _, key := range opts.Unset {
		delete(current, strings.TrimSpace(key))
	}

	if err := validateSecretData(current); err != nil {
		return err
	}

	if err := applySecret(ctx, opts.Options, current); err != nil {
		return err
	}

	_, err = fmt.Fprintf(stdout, "updated %s (%d key(s))\n", SecretName(opts.Project, opts.Env), len(current))
	return err
}

func Run(ctx context.Context, stdin io.Reader, stdout, stderr io.Writer, opts Options, command []string) error {
	if len(command) == 0 {
		return errors.New("missing command after --")
	}
	data, err := GetSecretData(ctx, opts)
	if err != nil {
		return err
	}
	if err := validateSecretData(data); err != nil {
		return err
	}

	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Env = mergeEnv(os.Environ(), data)
	return cmd.Run()
}

func Diff(ctx context.Context, stdout io.Writer, opts DiffOptions) error {
	fromData, err := GetSecretData(ctx, Options{
		Project:   opts.Project,
		Env:       opts.FromEnv,
		Namespace: opts.Namespace,
		Context:   opts.Context,
	})
	if err != nil {
		return err
	}
	toData, err := GetSecretData(ctx, Options{
		Project:   opts.Project,
		Env:       opts.ToEnv,
		Namespace: opts.Namespace,
		Context:   opts.Context,
	})
	if err != nil {
		return err
	}

	seen := map[string]struct{}{}
	allKeys := make([]string, 0, len(fromData)+len(toData))
	for key := range fromData {
		seen[key] = struct{}{}
		allKeys = append(allKeys, key)
	}
	for key := range toData {
		if _, ok := seen[key]; !ok {
			allKeys = append(allKeys, key)
		}
	}
	sort.Strings(allKeys)

	var lines []string
	for _, key := range allKeys {
		fromValue, fromOK := fromData[key]
		toValue, toOK := toData[key]
		switch {
		case fromOK && !toOK:
			lines = append(lines, fmt.Sprintf("only-in-%s %s", opts.FromEnv, key))
		case !fromOK && toOK:
			lines = append(lines, fmt.Sprintf("only-in-%s %s", opts.ToEnv, key))
		case fromValue != toValue:
			lines = append(lines, fmt.Sprintf("changed %s", key))
		}
	}

	if len(lines) == 0 {
		_, err := fmt.Fprintf(stdout, "no differences between %s and %s for project %s\n", opts.FromEnv, opts.ToEnv, opts.Project)
		return err
	}
	for _, line := range lines {
		if _, err := fmt.Fprintln(stdout, line); err != nil {
			return err
		}
	}
	return nil
}

func Promote(ctx context.Context, stdout io.Writer, opts PromoteOptions) error {
	fromOpts := Options{
		Project:   opts.Project,
		Env:       opts.FromEnv,
		Namespace: opts.Namespace,
		Context:   opts.Context,
	}
	toOpts := Options{
		Project:   opts.Project,
		Env:       opts.ToEnv,
		Namespace: opts.Namespace,
		Context:   opts.Context,
	}

	fromData, err := GetSecretData(ctx, fromOpts)
	if err != nil {
		return err
	}

	setOpts := SetOptions{
		Options: toOpts,
		Replace: opts.Replace,
	}
	for key, value := range fromData {
		setOpts.Pairs = append(setOpts.Pairs, key+"="+value)
	}
	if err := Set(ctx, io.Discard, setOpts); err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "promoted %d key(s) from %s to %s for project %s\n", len(fromData), opts.FromEnv, opts.ToEnv, opts.Project)
	return err
}

func GetSecretData(ctx context.Context, opts Options) (map[string]string, error) {
	if err := ValidateOptions(opts); err != nil {
		return nil, err
	}
	out, err := kubectl(ctx, opts, "-n", opts.Namespace, "get", "secret", SecretName(opts.Project, opts.Env), "-o", "json")
	if err != nil {
		return nil, err
	}

	var secret secretResponse
	if err := json.Unmarshal([]byte(out), &secret); err != nil {
		return nil, fmt.Errorf("decode secret JSON: %w", err)
	}

	data := map[string]string{}
	for key, encoded := range secret.Data {
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, fmt.Errorf("decode secret key %s: %w", key, err)
		}
		data[key] = string(decoded)
	}
	return data, nil
}

func IsSecretNotFound(err error) bool {
	return err != nil && strings.Contains(err.Error(), "NotFound")
}

func kubectl(ctx context.Context, opts Options, args ...string) (string, error) {
	cmdArgs := make([]string, 0, len(args)+2)
	if strings.TrimSpace(opts.Context) != "" {
		cmdArgs = append(cmdArgs, "--context", opts.Context)
	}
	cmdArgs = append(cmdArgs, args...)
	cmd := exec.CommandContext(ctx, "kubectl", cmdArgs...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("kubectl %s failed: %w\n%s", strings.Join(cmdArgs, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func applySecret(ctx context.Context, opts Options, data map[string]string) error {
	manifest := buildSecretManifest(opts, data)
	cmdArgs := make([]string, 0, 4)
	if strings.TrimSpace(opts.Context) != "" {
		cmdArgs = append(cmdArgs, "--context", opts.Context)
	}
	cmdArgs = append(cmdArgs, "apply", "-f", "-")
	cmd := exec.CommandContext(ctx, "kubectl", cmdArgs...)
	cmd.Stdin = strings.NewReader(manifest)
	out, applyErr := cmd.CombinedOutput()
	if applyErr != nil {
		return fmt.Errorf("kubectl %s failed: %w\n%s", strings.Join(cmdArgs, " "), applyErr, strings.TrimSpace(string(out)))
	}
	return nil
}

func buildSecretManifest(opts Options, data map[string]string) string {
	var b strings.Builder
	b.WriteString("apiVersion: v1\n")
	b.WriteString("kind: Secret\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + SecretName(opts.Project, opts.Env) + "\n")
	b.WriteString("  namespace: " + opts.Namespace + "\n")
	b.WriteString("type: Opaque\n")
	b.WriteString("stringData:\n")
	for _, key := range sortedKeys(data) {
		b.WriteString("  " + key + ": " + strconvQuote(data[key]) + "\n")
	}
	return b.String()
}

func validateIdentifier(label, value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return fmt.Errorf("%s identifier is empty", label)
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			continue
		}
		return fmt.Errorf("%s ID must be DNS-safe: lowercase alphanumeric + hyphens", label)
	}
	if strings.HasPrefix(value, "-") || strings.HasSuffix(value, "-") {
		return fmt.Errorf("%s ID must start and end with alphanumeric characters", label)
	}
	return nil
}

func sanitizeIdentifier(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "_", "-")
	return value
}

func parseDotenvFile(path string) (map[string]string, error) {
	if strings.TrimSpace(path) == "" {
		return map[string]string{}, nil
	}
	content, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return nil, fmt.Errorf("read env file %s: %w", path, err)
	}
	return parseDotenv(string(content))
}

func parseDotenv(content string) (map[string]string, error) {
	data := map[string]string{}
	for index, raw := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("invalid dotenv line %d: %q", index+1, raw)
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if _, exists := data[key]; exists {
			return nil, fmt.Errorf("duplicate key %s in dotenv input", key)
		}
		data[key] = strings.Trim(value, `"'`)
	}
	return data, nil
}

func parseInlinePairs(pairs []string) (map[string]string, error) {
	data := map[string]string{}
	for _, pair := range pairs {
		key, value, ok := strings.Cut(pair, "=")
		if !ok {
			return nil, fmt.Errorf("invalid KEY=value pair %q", pair)
		}
		key = strings.TrimSpace(key)
		if key == "" {
			return nil, fmt.Errorf("invalid empty key in pair %q", pair)
		}
		if _, exists := data[key]; exists {
			return nil, fmt.Errorf("duplicate inline key %s", key)
		}
		data[key] = value
	}
	return data, nil
}

func validateSecretData(data map[string]string) error {
	for key := range data {
		if strings.TrimSpace(key) == "" {
			return errors.New("environment key must not be empty")
		}
		if strings.HasPrefix(key, "SMITHERS_") {
			return fmt.Errorf("reserved key %s cannot be managed through project env", key)
		}
	}
	return nil
}

func sortedKeys(data map[string]string) []string {
	keys := make([]string, 0, len(data))
	for key := range data {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func renderDotenv(data map[string]string) string {
	var b strings.Builder
	for _, key := range sortedKeys(data) {
		b.WriteString(key + "=" + shellEscape(data[key]) + "\n")
	}
	return b.String()
}

func shellEscape(value string) string {
	if value == "" {
		return `""`
	}
	return strconvQuote(value)
}

func mergeEnv(base []string, overlay map[string]string) []string {
	envMap := map[string]string{}
	order := make([]string, 0, len(base)+len(overlay))
	for _, entry := range base {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if _, exists := envMap[key]; !exists {
			order = append(order, key)
		}
		envMap[key] = value
	}
	for _, key := range sortedKeys(overlay) {
		if _, exists := envMap[key]; !exists {
			order = append(order, key)
		}
		envMap[key] = overlay[key]
	}

	result := make([]string, 0, len(order))
	for _, key := range order {
		result = append(result, key+"="+envMap[key])
	}
	return result
}

func strconvQuote(value string) string {
	return fmt.Sprintf("%q", value)
}
