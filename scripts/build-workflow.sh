#!/bin/bash
# Bundle smithers workflow to standalone JS
# This creates a self-contained workflow that doesn't need project dependencies

set -e

WORKFLOW_SRC="${1:-scripts/smithers-dynamic-runner.tsx}"
OUTPUT="${2:-dist/smithers-workflow.js}"

echo "Building workflow bundle..."
echo "  Source: $WORKFLOW_SRC"
echo "  Output: $OUTPUT"

# Bundle with bun - creates standalone JS with all dependencies included
bun build "$WORKFLOW_SRC" \
  --outfile "$OUTPUT" \
  --target node \
  --format cjs \
  --external react \
  --external react-dom \
  --external smithers-orchestrator

# Add shebang for direct execution
echo "Adding shebang..."
echo '#!/usr/bin/env node' | cat - "$OUTPUT" > /tmp/workflow-with-shebang.js
mv /tmp/workflow-with-shebang.js "$OUTPUT"
chmod +x "$OUTPUT"

echo "✅ Workflow bundled: $OUTPUT"
echo ""
echo "This bundle can be executed directly without installing dependencies in the target project."
