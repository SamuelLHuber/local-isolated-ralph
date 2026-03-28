FROM node:20-bookworm-slim

ARG JJ_VERSION=0.37.0
ARG GO_VERSION=1.26.1
ARG FABRIK_RUNTIME_VERSION=

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash curl git make tar ca-certificates wget \
    # Shared libraries for headless Chromium (Playwright, Puppeteer, etc.)
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 libglib2.0-0 \
    libxfixes3 fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

# kubectl
RUN arch="$(dpkg --print-architecture)" \
  && curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/${arch}/kubectl" \
    -o /usr/local/bin/kubectl \
  && chmod +x /usr/local/bin/kubectl

# Go
RUN arch="$(dpkg --print-architecture)" \
  && wget -qO- "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" \
    | tar -xz -C /usr/local \
  && ln -sf /usr/local/go/bin/go /usr/local/bin/go \
  && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt

# JJ (jujutsu)
RUN arch="$(dpkg --print-architecture)" \
  && case "${arch}" in \
    amd64) jj_arch="x86_64" ;; \
    arm64) jj_arch="aarch64" ;; \
    *) echo "unsupported architecture: ${arch}" >&2; exit 1 ;; \
  esac \
  && wget -qO- "https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}/jj-v${JJ_VERSION}-${jj_arch}-unknown-linux-musl.tar.gz" \
    | tar -xz -C /usr/local/bin ./jj

RUN git --version && jj --version

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
COPY src/fabrik-runtime ${SMITHERS_RUNTIME_DIR}/vendor/fabrik-runtime

RUN rm -rf ${SMITHERS_RUNTIME_DIR}/vendor/fabrik-runtime/node_modules
RUN node -e 'const fs=require("fs"); const path=process.env.SMITHERS_RUNTIME_DIR + "/package.json"; const pkg=JSON.parse(fs.readFileSync(path,"utf8")); pkg.dependencies ||= {}; pkg.dependencies["@dtechvision/fabrik-runtime"] = process.env.FABRIK_RUNTIME_VERSION ? process.env.FABRIK_RUNTIME_VERSION : "file:./vendor/fabrik-runtime"; fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");'
RUN cd ${SMITHERS_RUNTIME_DIR} && npm install --no-audit --no-fund
RUN ln -sfn ${SMITHERS_RUNTIME_DIR}/node_modules ${SMITHERS_RUNTIME_DIR}/vendor/fabrik-runtime/node_modules
RUN chmod +x ${SMITHERS_RUNTIME_DIR}/run.sh

WORKDIR ${SMITHERS_WORKDIR}
ENTRYPOINT ["/opt/smithers-runtime/run.sh"]
