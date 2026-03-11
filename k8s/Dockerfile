FROM node:20-alpine

ARG JJ_VERSION=0.37.0

RUN apk add --no-cache bash curl git go kubectl make
RUN wget -qO- "https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}/jj-v${JJ_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
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
