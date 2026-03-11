.PHONY: verify verify-cli verify-cli-unit verify-cli-k3d

verify: verify-cli

verify-cli: verify-cli-unit

verify-cli-unit:
	cd src/fabrik-cli && go test ./...

verify-cli-k3d:
	cd src/fabrik-cli && FABRIK_K3D_E2E=1 go test ./internal/run -run 'TestK3d' -v
