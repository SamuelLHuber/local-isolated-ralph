import { readFileSync } from "node:fs";
import { z } from "zod";

export const todoItemSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .describe("Stable lowercase kebab-case item id"),
  title: z.string(),
  status: z.enum(["pending", "done"]),
  task: z.string(),
  specTieIn: z.array(z.string()),
  guarantees: z.array(z.string()),
  verificationToBuildFirst: z.array(z.string()),
  requiredChecks: z.array(z.string()),
  documentationUpdates: z.array(z.string()),
  blockedReason: z.string().nullable(),
});

export type TodoItem = z.infer<typeof todoItemSchema>;

type TodoHeading = {
  title: string;
  status: "pending" | "done";
};

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

function normalizeMarkdownList(lines: string[]): string[] {
  const items: string[] = [];
  let current = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;

    const bullet = line.match(/^[-*]\s+(.*)$/);
    const numbered = line.match(/^\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      if (current !== "") items.push(current);
      current = (bullet?.[1] ?? numbered?.[1] ?? "").trim();
      continue;
    }

    if (current !== "") {
      current += ` ${line}`;
    } else {
      current = line;
    }
  }

  if (current !== "") items.push(current);
  return items;
}

function normalizeParagraph(lines: string[]): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

function parseTodoHeading(rawTitle: string): TodoHeading {
  const title = rawTitle.trim();
  const doneMatch = title.match(/^(.*)\s+\[(done)\]\s*$/i);
  if (doneMatch) {
    return {
      title: doneMatch[1]?.trim() ?? title,
      status: "done",
    };
  }

  return {
    title,
    status: "pending",
  };
}

function buildTodoItem(heading: TodoHeading, lines: string[]): TodoItem {
  const sections = new Map<string, string[]>();
  let currentSection = "";

  for (const line of lines) {
    const heading = line.match(/^###\s+(.*)$/);
    if (heading) {
      currentSection = heading[1].trim().toLowerCase();
      if (!sections.has(currentSection)) {
        sections.set(currentSection, []);
      }
      continue;
    }

    if (currentSection !== "") {
      sections.get(currentSection)?.push(line);
    }
  }

  const task = normalizeParagraph(sections.get("task") ?? []);
  const specTieIn = normalizeMarkdownList(sections.get("spec tie-in") ?? []);
  const guarantees = normalizeMarkdownList(sections.get("guarantees") ?? []);
  const verificationToBuildFirst = normalizeMarkdownList(
    sections.get("verification to build first") ?? [],
  );
  const requiredChecks = normalizeMarkdownList(
    sections.get("required checks") ?? [],
  );
  const documentationUpdates = normalizeMarkdownList(
    sections.get("documentation updates") ?? [],
  );

  const missing: string[] = [];
  if (task === "") missing.push("Task");
  if (specTieIn.length === 0) missing.push("Spec tie-in");
  if (guarantees.length === 0) missing.push("Guarantees");
  if (verificationToBuildFirst.length === 0) {
    missing.push("Verification to build first");
  }
  if (requiredChecks.length === 0) missing.push("Required checks");

  return todoItemSchema.parse({
    id: slugifyTitle(heading.title),
    title: heading.title,
    status: heading.status,
    task,
    specTieIn,
    guarantees,
    verificationToBuildFirst,
    requiredChecks,
    documentationUpdates,
    blockedReason:
      missing.length > 0
        ? `Missing required sections in todo.md: ${missing.join(", ")}.`
        : null,
  });
}

export function parseTodoContent(content: string): TodoItem[] {
  const lines = content.replace(/\r/g, "").split("\n");
  const items: TodoItem[] = [];

  let currentHeading: TodoHeading | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentHeading) return;
    items.push(buildTodoItem(currentHeading, currentLines));
    currentHeading = null;
    currentLines = [];
  };

  for (const line of lines) {
    const numberedHeading = line.match(/^##\s+\d+\.\s+(.*)$/);
    if (numberedHeading) {
      flush();
      currentHeading = parseTodoHeading(numberedHeading[1] ?? "");
      continue;
    }

    if (/^##\s+/.test(line)) {
      flush();
      continue;
    }

    if (currentHeading) {
      currentLines.push(line);
    }
  }

  flush();
  return items;
}

export function parseTodoItems(todoPath: string): TodoItem[] {
  return parseTodoContent(readFileSync(todoPath, "utf8"));
}
