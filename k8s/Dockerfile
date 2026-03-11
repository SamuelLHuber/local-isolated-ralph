FROM node:20-alpine

ARG JJ_VERSION=0.37.0
ARG GO_VERSION=1.26.1

RUN apk add --no-cache bash curl git kubectl make tar

RUN arch="$(apk --print-arch)" \
  && case "${arch}" in \
    x86_64) go_arch="amd64" ;; \
    aarch64) go_arch="arm64" ;; \
    *) echo "unsupported apk architecture: ${arch}" >&2; exit 1 ;; \
  esac \
  && wget -qO- "https://go.dev/dl/go${GO_VERSION}.linux-${go_arch}.tar.gz" \
    | tar -xz -C /usr/local \
  && ln -sf /usr/local/go/bin/go /usr/local/bin/go \
  && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt

RUN arch="$(apk --print-arch)" \
  && case "${arch}" in \
    x86_64) jj_arch="x86_64" ;; \
    aarch64) jj_arch="aarch64" ;; \
    *) echo "unsupported apk architecture: ${arch}" >&2; exit 1 ;; \
  esac \
  && wget -qO- "https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}/jj-v${JJ_VERSION}-${jj_arch}-unknown-linux-musl.tar.gz" \
    | tar -xz -C /usr/local/bin ./jj

# Smithers CLI requires Bun at runtime (shebang: /usr/bin/env bun).
RUN npm install --global \
  bun \
  smithers-orchestrator \
  @mariozechner/pi-coding-agent@0.57.1 \
  @openai/codex \
  @anthropic-ai/claude-code

ENV SMITHERS_RUNTIME_DIR=/opt/smithers-runtime
ENV SMITHERS_WORKDIR=/workspace/workdir
ENV SMITHERS_DB_PATH=/workspace/.smithers/state.db

RUN mkdir -p ${SMITHERS_RUNTIME_DIR} ${SMITHERS_WORKDIR} /workspace/.smithers /root/.codex

COPY k8s/smithers-runtime/package.json ${SMITHERS_RUNTIME_DIR}/package.json
COPY k8s/smithers-runtime/workflow.tsx ${SMITHERS_RUNTIME_DIR}/workflow.tsx
COPY k8s/smithers-runtime/run.sh ${SMITHERS_RUNTIME_DIR}/run.sh

RUN cd ${SMITHERS_RUNTIME_DIR} && npm install --no-audit --no-fund
RUN chmod +x ${SMITHERS_RUNTIME_DIR}/run.sh

WORKDIR ${SMITHERS_WORKDIR}
ENTRYPOINT ["/opt/smithers-runtime/run.sh"]
