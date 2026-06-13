import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppContext } from "../../server.js";
import { getActiveProject, jsonError, jsonResult, resolveProjectPath, sha256 } from "../dev/common.js";

const NOTES_DIR = "src/content/notes";
const NOTES_GUIDELINES = `Notes は、公開される個人メモ置き場。記事ではなく、あとで見返せる短いメモとして書く。

- 何のメモか最初に書く。
- 公開されても問題ない情報だけ書く。
- チャット内で本文を確認してから作成する。
- 導入、背景、感想、語りは増やさない。
- 作業ログや関連ファイル一覧は基本的に書かない。
- ファイル名、URL、設定値、コマンドは必要なときだけ残す。
- 調べた内容は、分かったことと未確認を分ける。
- 判断を書くなら、条件付きで短く書く。
- 出典がある場合は参照に残す。
- 他人に説明しきる必要はないが、共有していない文脈に依存しすぎない。

一文に圧縮:

Notes は、公開してもよい短いメモを、あとで見返せる粒度で残す場所。`

type CreateArgs = {
  title?: string;
  description?: string;
  tags?: string[];
  source_urls?: string[];
  body?: string;
  slug?: string;
  overwrite?: boolean;
};

type ValidateArgs = { path?: string };

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlStringArray(values: string[]): string {
  if (values.length === 0) return "[]";
  return `[${values.map(yamlString).join(", ")}]`;
}

function normalizeStringArray(value: unknown, field: string): string[] | { error: string } {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return { error: `${field} must be an array of strings.` };
  const result = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  if (result.length !== value.length) return { error: `${field} must be an array of non-empty strings.` };
  return Array.from(new Set(result));
}

function validateUrls(urls: string[]): string[] {
  return urls.filter((url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  });
}

function frontmatter(args: {
  title: string;
  description: string;
  tags: string[];
  sourceUrls: string[];
}): string {
  const date = todayIsoDate();
  return `---\ntitle: ${yamlString(args.title)}\ncreatedAt: ${date}\ndescription: ${yamlString(args.description)}\ntags: ${yamlStringArray(args.tags)}\nsourceUrls: ${yamlStringArray(args.sourceUrls)}\n---\n\n`;
}

function parseFrontmatter(text: string): Record<string, string> | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const raw = text.slice(4, end);
  const data: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (match) data[match[1]] = match[2].trim();
  }
  return data;
}

function ensureHomepageProject(projectId: string) {
  if (projectId !== "homepage") {
    return jsonError(
      "NOT_HOMEPAGE_PROJECT",
      "notes tools are intentionally restricted to the homepage project. Call project.select with project_id=homepage first.",
      { selected_project: projectId },
    );
  }
  return null;
}

export async function handleNotesGuidelines() {
  return jsonResult({
    title: "Notes writing guidelines",
    text: NOTES_GUIDELINES,
    guidelines: NOTES_GUIDELINES.split("\n").filter((line) => line.trim().length > 0),
  });
}

export async function handleNotesCreate(
  ctx: AppContext,
  chatContextId: string,
  args: CreateArgs,
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const projectError = ensureHomepageProject(project.projectId);
  if (projectError) return projectError;

  const title = args?.title?.trim();
  if (!title) return jsonError("MISSING_TITLE", "notes.create requires a title.");
  const description = args.description?.trim();
  if (!description) return jsonError("MISSING_DESCRIPTION", "notes.create requires a description reviewed in chat before writing.");
  const bodyText = args.body?.trim();
  if (!bodyText) return jsonError("MISSING_BODY", "notes.create requires a body reviewed in chat before writing.");

  const tags = normalizeStringArray(args.tags, "tags");
  if (!Array.isArray(tags)) return jsonError("INVALID_TAGS", tags.error);
  const sourceUrls = normalizeStringArray(args.source_urls, "source_urls");
  if (!Array.isArray(sourceUrls)) return jsonError("INVALID_SOURCE_URLS", sourceUrls.error);
  const validSourceUrls = validateUrls(sourceUrls);
  if (validSourceUrls.length !== sourceUrls.length) {
    return jsonError("INVALID_SOURCE_URLS", "source_urls must contain valid http(s) URLs.", { source_urls: sourceUrls });
  }

  const slugBase = slugify(args.slug?.trim() || title);
  const slug = slugBase || `note-${todayIsoDate()}-${sha256(title).slice(0, 8)}`;
  const relativePath = `${NOTES_DIR}/${slug}.md`;
  const resolved = resolveProjectPath(project, relativePath);
  if (!resolved.ok) return jsonError(resolved.code, resolved.message);

  const overwrite = args.overwrite === true;
  if (existsSync(resolved.absolutePath) && !overwrite) {
    return jsonError("NOTE_ALREADY_EXISTS", "A note with this slug already exists. Pass overwrite=true to replace it.", {
      path: resolved.relativePath,
      slug,
    });
  }

  const content = `${frontmatter({ title, description, tags, sourceUrls: validSourceUrls })}${bodyText}\n`;

  await mkdir(dirname(resolved.absolutePath), { recursive: true });
  await writeFile(resolved.absolutePath, content, "utf8");

  return jsonResult({
    created: true,
    overwritten: overwrite,
    project_id: project.projectId,
    path: resolved.relativePath,
    slug,
    preview_path: `/notes/${slug}`,
    sha256: sha256(content),
    frontmatter: {
      title,
      createdAt: todayIsoDate(),
      description,
      tags,
      sourceUrls: validSourceUrls,
    },
    warnings: validSourceUrls.length === 0 ? ["source_urls is empty."] : [],
  });
}

async function walkMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  async function visit(dir: string) {
    for (const entry of await readdir(dir)) {
      const absolute = join(dir, entry);
      const info = await stat(absolute);
      if (info.isDirectory()) {
        if (entry.startsWith("_")) continue;
        await visit(absolute);
      } else if (entry.endsWith(".md") || entry.endsWith(".mdx")) {
        out.push(absolute);
      }
    }
  }
  await visit(root);
  return out;
}

export async function handleNotesValidate(
  ctx: AppContext,
  chatContextId: string,
  args: ValidateArgs,
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const projectError = ensureHomepageProject(project.projectId);
  if (projectError) return projectError;

  const target = args?.path?.trim() || NOTES_DIR;
  const resolved = resolveProjectPath(project, target, { allowDirectory: true });
  if (!resolved.ok) return jsonError(resolved.code, resolved.message);
  if (!resolved.relativePath.startsWith(NOTES_DIR)) {
    return jsonError("PATH_OUTSIDE_NOTES", `notes.validate can only inspect ${NOTES_DIR}.`);
  }

  const files = existsSync(resolved.absolutePath) && (await stat(resolved.absolutePath)).isDirectory()
    ? await walkMarkdownFiles(resolved.absolutePath)
    : [resolved.absolutePath];

  const notes = [];
  const issues = [];
  for (const absolute of files) {
    if (!existsSync(absolute)) {
      issues.push({ path: resolved.relativePath, code: "MISSING_FILE", message: "File does not exist." });
      continue;
    }
    const text = await readFile(absolute, "utf8");
    const relative = absolute.slice(project.hostRoot.length + 1).replace(/\\/g, "/");
    const fm = parseFrontmatter(text);
    if (!fm) {
      issues.push({ path: relative, code: "MISSING_FRONTMATTER", message: "Note must start with YAML frontmatter." });
      continue;
    }
    for (const key of ["title", "createdAt", "description", "tags", "sourceUrls"]) {
      if (!(key in fm)) issues.push({ path: relative, code: "MISSING_FIELD", field: key, message: `Missing frontmatter field: ${key}` });
    }
    notes.push({
      path: relative,
      title: fm.title?.replace(/^['\"]|['\"]$/g, "") ?? null,
      createdAt: fm.createdAt ?? null,
    });
  }

  return jsonResult({
    project_id: project.projectId,
    root: resolved.relativePath,
    total_notes: notes.length,
    valid: issues.length === 0,
    notes,
    issues,
  });
}
