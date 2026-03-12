import https from "node:https";
import { readFileSync } from "node:fs";

const SERVICE_ACCOUNT_TOKEN = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const SERVICE_ACCOUNT_CA = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

export type VerificationResult = {
  passed: boolean;
  jobName: string;
  podName: string;
  commands: string[];
  logs: string;
  summary: string;
};

type VerificationJobOptions = {
  name: string;
  image: string;
  namespace: string;
  serviceAccountName: string;
  pvcName: string;
  nodeName: string;
  workspacePath: string;
  commands: string[];
  cleanupCommands?: string[];
  labels?: Record<string, string>;
  timeoutSeconds?: number;
};

type K8sObjectMeta = {
  name: string;
  namespace: string;
};

type PodList = {
  items?: Array<{
    metadata?: {
      name?: string;
      labels?: Record<string, string>;
    };
  }>;
};

type JobStatus = {
  status?: {
    succeeded?: number;
    failed?: number;
  };
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required Kubernetes environment variable ${name}.`);
  }
  return value;
}

function k8sRequest(
  method: string,
  path: string,
  body?: string,
  contentType = "application/json",
): Promise<string> {
  const token = readFileSync(SERVICE_ACCOUNT_TOKEN, "utf8").trim();
  const ca = readFileSync(SERVICE_ACCOUNT_CA);
  const host = requiredEnv("KUBERNETES_SERVICE_HOST");
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS?.trim() || "443";

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        port,
        method,
        path,
        ca,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body
            ? {
                "Content-Type": contentType,
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          const statusCode = res.statusCode ?? 500;
          if (statusCode >= 200 && statusCode < 300) {
            resolve(data);
            return;
          }
          reject(
            new Error(
              `Kubernetes API ${method} ${path} failed with ${statusCode}: ${data}`,
            ),
          );
        });
      },
    );

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function createJob(namespace: string, manifest: unknown): Promise<K8sObjectMeta> {
  const response = await k8sRequest(
    "POST",
    `/apis/batch/v1/namespaces/${namespace}/jobs`,
    JSON.stringify(manifest),
  );
  const parsed = JSON.parse(response) as { metadata?: K8sObjectMeta };
  if (!parsed.metadata?.name || !parsed.metadata?.namespace) {
    throw new Error("Kubernetes API create job response did not include metadata.");
  }
  return parsed.metadata;
}

async function getJob(namespace: string, jobName: string): Promise<JobStatus> {
  const response = await k8sRequest(
    "GET",
    `/apis/batch/v1/namespaces/${namespace}/jobs/${jobName}`,
  );
  return JSON.parse(response) as JobStatus;
}

async function listPodsForJob(namespace: string, jobName: string): Promise<string[]> {
  const response = await k8sRequest(
    "GET",
    `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`,
  );
  const parsed = JSON.parse(response) as PodList;
  return (parsed.items ?? [])
    .map((item) => item.metadata?.name?.trim() ?? "")
    .filter((name) => name !== "");
}

async function getPodLogs(namespace: string, podName: string): Promise<string> {
  return await k8sRequest(
    "GET",
    `/api/v1/namespaces/${namespace}/pods/${podName}/log?container=fabrik`,
    undefined,
    "text/plain",
  );
}

async function deleteJob(namespace: string, jobName: string): Promise<void> {
  await k8sRequest(
    "DELETE",
    `/apis/batch/v1/namespaces/${namespace}/jobs/${jobName}?propagationPolicy=Background`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildVerifierScript(
  commands: readonly string[],
  cleanupCommands: readonly string[] = [],
): string {
  const lines = ["set -euo pipefail"];
  if (cleanupCommands.length > 0) {
    lines.push("cleanup() {");
    for (const command of cleanupCommands) {
      lines.push(`  ${command}`);
    }
    lines.push("}");
    lines.push("trap cleanup EXIT");
  }
  lines.push(...commands);
  return lines.join("\n");
}

export async function runVerificationJob(
  options: VerificationJobOptions,
): Promise<VerificationResult> {
  const timeoutMs = (options.timeoutSeconds ?? 900) * 1000;
  const manifest = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: options.name,
      namespace: options.namespace,
      labels: {
        "fabrik.sh/managed-by": "fabrik",
        "fabrik.sh/phase": "verify",
        "fabrik.sh/task": options.name,
        ...(options.labels ?? {}),
      },
    },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit: 0,
      template: {
        metadata: {
          labels: {
            "fabrik.sh/managed-by": "fabrik",
            "fabrik.sh/phase": "verify",
            "fabrik.sh/task": options.name,
            ...(options.labels ?? {}),
          },
        },
        spec: {
          serviceAccountName: options.serviceAccountName,
          restartPolicy: "Never",
          nodeName: options.nodeName,
          containers: [
            {
              name: "fabrik",
              image: options.image,
              imagePullPolicy: "IfNotPresent",
              command: [
                "sh",
                "-lc",
                buildVerifierScript(
                  options.commands,
                  options.cleanupCommands ?? [],
                ),
              ],
              workingDir: options.workspacePath,
              volumeMounts: [
                {
                  name: "workspace",
                  mountPath: "/workspace",
                },
              ],
            },
          ],
          volumes: [
            {
              name: "workspace",
              persistentVolumeClaim: {
                claimName: options.pvcName,
              },
            },
          ],
        },
      },
    },
  };

  const created = await createJob(options.namespace, manifest);
  const startedAt = Date.now();
  let podName = "";
  let logs = "";

  try {
    for (;;) {
      if (Date.now()-startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for verification job ${created.name}.`);
      }

      const job = await getJob(options.namespace, created.name);
      const pods = await listPodsForJob(options.namespace, created.name);
      if (pods.length > 0) {
        podName = pods[0]!;
      }

      if ((job.status?.succeeded ?? 0) > 0) {
        if (podName) {
          logs = await getPodLogs(options.namespace, podName);
        }
        return {
          passed: true,
          jobName: created.name,
          podName,
          commands: [...options.commands],
          logs,
          summary: `Verification job ${created.name} succeeded.`,
        };
      }

      if ((job.status?.failed ?? 0) > 0) {
        if (podName) {
          logs = await getPodLogs(options.namespace, podName);
        }
        return {
          passed: false,
          jobName: created.name,
          podName,
          commands: [...options.commands],
          logs,
          summary: `Verification job ${created.name} failed.`,
        };
      }

      await sleep(2000);
    }
  } finally {
    await deleteJob(options.namespace, created.name).catch(() => undefined);
  }
}
