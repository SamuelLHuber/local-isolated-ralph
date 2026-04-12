import { expect, test } from "bun:test";
import { buildVerificationJobManifest } from "./k8s-jobs";

test("verification jobs receive required parent environment", () => {
  const manifest = buildVerificationJobManifest({
    name: "verify-demo",
    image: "ghcr.io/example/fabrik@sha256:abc123",
    namespace: "fabrik-runs",
    serviceAccountName: "fabrik-runner-demo",
    pvcName: "data-demo",
    nodeName: "node-a",
    workspacePath: "/workspace/workdir",
    commands: ["echo ok"],
  });

  const container = manifest.spec.template.spec.containers[0];
  expect(container?.env).toEqual(
    expect.arrayContaining([
      { name: "FABRIK_RUN_IMAGE", value: "ghcr.io/example/fabrik@sha256:abc123" },
      { name: "KUBERNETES_NAMESPACE", value: "fabrik-runs" },
      { name: "FABRIK_WORKSPACE_PVC", value: "data-demo" },
      { name: "KUBERNETES_NODE_NAME", value: "node-a" },
    ]),
  );
});
