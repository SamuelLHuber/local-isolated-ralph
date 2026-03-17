.PHONY: verify verify-cli verify-cli-unit verify-cli-k3d

FABRIK_K3D_CLUSTER ?= dev-single

verify: verify-cli

verify-cli: verify-cli-unit

verify-cli-unit:
	cd src/fabrik-cli && go test ./...

verify-cli-k3d:
	cd src/fabrik-cli && FABRIK_K3D_E2E=1 FABRIK_K3D_CLUSTER=$(FABRIK_K3D_CLUSTER) go test ./internal/run -run 'TestK3d' -timeout 20m -v
