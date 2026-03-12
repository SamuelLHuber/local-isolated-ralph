import { readFileSync, writeFileSync } from "node:fs";
import { parseTodoContent } from "./todo-plan";

type MarkTodoDoneOptions = {
  runID?: string;
  verificationSummary?: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function headingPattern(title: string): RegExp {
  return new RegExp(
    `^(##\\s+\\d+\\.\\s+)${escapeRegExp(title)}(?:\\s+\\[done\\])?\\s*$`,
    "m",
  );
}

function buildMetadataLines(options: MarkTodoDoneOptions): string[] {
  const lines = ["Status: done"];
  if (options.runID?.trim()) {
    lines.push(`Verified by workflow run: ${options.runID.trim()}`);
  }
  if (options.verificationSummary?.trim()) {
    lines.push(`Verification summary: ${options.verificationSummary.trim()}`);
  }
  return lines;
}

export function markTodoContentDone(
  content: string,
  itemID: string,
  options: MarkTodoDoneOptions = {},
): string {
  const parsedItems = parseTodoContent(content);
  const target = parsedItems.find((entry) => entry.id === itemID);
  if (!target) {
    throw new Error(`Could not find todo item '${itemID}' in todo.md.`);
  }

  const pattern = headingPattern(target.title);
  const match = content.match(pattern);
  if (!match || typeof match.index !== "number") {
    throw new Error(`Could not locate heading for todo item '${itemID}'.`);
  }

  const headingPrefix = match[1] ?? "";
  const lineEnd = content.indexOf("\n", match.index);
  const headingEnd = lineEnd >= 0 ? lineEnd : content.length;
  const nextSectionIndex = content.indexOf("\n### ", headingEnd);
  const metadataEnd = nextSectionIndex >= 0 ? nextSectionIndex : content.length;
  const existingMetadata = content.slice(headingEnd, metadataEnd);
  const strippedMetadata = existingMetadata
    .replace(/^\n+/, "\n")
    .replace(/\nStatus: done[^\n]*\n?/g, "\n")
    .replace(/\nVerified by workflow run:[^\n]*\n?/g, "\n")
    .replace(/\nVerification summary:[^\n]*\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  const headingLine = `${headingPrefix}${target.title} [done]`;
  const metadataBlock = `\n${buildMetadataLines(options).join("\n")}\n`;

  return (
    content.slice(0, match.index) +
    headingLine +
    metadataBlock +
    strippedMetadata.replace(/^\n*/, "\n") +
    content.slice(metadataEnd)
  );
}

export function markTodoItemDone(
  todoPath: string,
  itemID: string,
  options: MarkTodoDoneOptions = {},
): void {
  const content = readFileSync(todoPath, "utf8");
  const updated = markTodoContentDone(content, itemID, options);
  writeFileSync(todoPath, updated);
}
