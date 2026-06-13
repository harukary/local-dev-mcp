import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppContext } from "../../server.js";
import { getActiveProject, jsonError, jsonResult, resolveProjectPath, sha256 } from "../dev/common.js";

const NOTES_DIR = "src/content/notes";
const VALID_CONFIDENCE = new Set(["draft", "checked", "verified"]);
const NOTES_GUIDELINES = `Notes は、あとで再利用するための情報の圧縮。

- 対象を最初に書く。
- 目的語を曖昧にしない。
- 前提は、誤読に関わるものだけ書く。
- 共有していない文脈を前提にしない。
- 導入、背景、感想、語りを削る。
- 作業順ではなく、分かったことを書く。
- 事実、条件、差分、制約を優先する。
- 判断を書くなら、条件付きで短く書く。
- 一般論の注意喚起は書かない。
- 固有名詞は役割が分かる範囲で使う。
- 内部事情は、再利用に必要な場合だけ書く。
- 比較では、説明より差分を書く。
- 手順では、理由より再現条件を書く。
- エラーでは、経緯より原因と回避策を書く。
- 調査では、網羅感より確認済み範囲を書く。
- 未確認事項は短く残す。
- 出典は残す。
- 文章でつなげず、情報の塊として並べる。
- 見出しは情報種別で切る。例: 対象、結論、差分、条件、制約、手順、原因、回避策、未確認、参照。
- 読後に、調べ直す時間が減る状態を目指す。

判断基準:

- これは後で検索・再利用できる情報か。
- この文は前提なしに意味が取れるか。
- これは事実か、判断か、感想か。
- この判断の条件は書いてあるか。
- この固有名詞は説明なしで通じる必要があるか。
- この文は作業ログになっていないか。
- この文を消しても情報量が減らないなら消す。

一文に圧縮:

Notes は、対象・事実・差分・条件・制約・参照を、共有されていない文脈に依存せず、最短で再利用できる形に圧縮する。`;

type CreateDraftArgs = {
  title?: string;
  question?: string;
  description?: string;
  tags?: string[];
  source_urls?: string[];
  body?: string;
  slug?: string;
  confidence?: string;
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

function defaultBody(title: string, question?: string, sourceUrls: string[] = []): string {
  const q = question?.trim() || title;
  const refs = sourceUrls.length > 0
    ? sourceUrls.map((url) => `- ${url}`).join("\n")
    : "- ここに参照 URL を追加する";
  return `## 疑問\n\n${q}\n\n## 結論\n\nここに結論を書く。\n\n## メモ\n\n- 重要な前提\n- 判断理由\n- 後で見返すポイント\n\n## 参照\n\n${refs}\n`;
}

function frontmatter(args: {
  title: string;
  description: string;
  tags: string[];
  sourceUrls: string[];
  confidence: string;
}): string {
  const date = todayIsoDate();
  return `---\ntitle: ${yamlString(args.title)}\ncreatedAt: ${date}\ndescription: ${yamlString(args.description)}\ntags: ${yamlStringArray(args.tags)}\nsourceUrls: ${yamlStringArray(args.sourceUrls)}\ndraft: true\nconfidence: ${yamlString(args.confidence)}\n---\n\n`;
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

export async function handleNotesCreateDraft(
  ctx: AppContext,
  chatContextId: string,
  args: CreateDraftArgs,
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const projectError = ensureHomepageProject(project.projectId);
  if (projectError) return projectError;

  const title = args?.title?.trim();
  if (!title) return jsonError("MISSING_TITLE", "notes.create_draft requires a title.");

  const tags = normalizeStringArray(args.tags, "tags");
  if (!Array.isArray(tags)) return jsonError("INVALID_TAGS", tags.error);
  const sourceUrls = normalizeStringArray(args.source_urls, "source_urls");
  if (!Array.isArray(sourceUrls)) return jsonError("INVALID_SOURCE_URLS", sourceUrls.error);
  const validSourceUrls = validateUrls(sourceUrls);
  if (validSourceUrls.length !== sourceUrls.length) {
    return jsonError("INVALID_SOURCE_URLS", "source_urls must contain valid http(s) URLs.", { source_urls: sourceUrls });
  }

  const confidence = args.confidence ?? "draft";
  if (!VALID_CONFIDENCE.has(confidence)) {
    return jsonError("INVALID_CONFIDENCE", "confidence must be one of: draft, checked, verified.");
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

  const description = args.description?.trim() || `「${title}」についての技術ノート。`;
  const body = args.body?.trim() || defaultBody(title, args.question, validSourceUrls);
  const content = `${frontmatter({ title, description, tags, sourceUrls: validSourceUrls, confidence })}${body.trim()}\n`;

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
      draft: true,
      confidence,
    },
    warnings: validSourceUrls.length === 0 ? ["source_urls is empty. Add references before marking the note checked or verified."] : [],
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
    for (const key of ["title", "createdAt", "description", "tags", "sourceUrls", "draft", "confidence"]) {
      if (!(key in fm)) issues.push({ path: relative, code: "MISSING_FIELD", field: key, message: `Missing frontmatter field: ${key}` });
    }
    if (fm.confidence && !VALID_CONFIDENCE.has(fm.confidence.replace(/^['\"]|['\"]$/g, ""))) {
      issues.push({ path: relative, code: "INVALID_CONFIDENCE", message: "confidence must be draft, checked, or verified." });
    }
    if (fm.confidence && fm.confidence.replace(/^['\"]|['\"]$/g, "") !== "draft" && fm.sourceUrls === "[]") {
      issues.push({ path: relative, code: "MISSING_SOURCES", message: "checked/verified notes should include sourceUrls." });
    }
    notes.push({
      path: relative,
      title: fm.title?.replace(/^['\"]|['\"]$/g, "") ?? null,
      createdAt: fm.createdAt ?? null,
      draft: fm.draft ?? null,
      confidence: fm.confidence?.replace(/^['\"]|['\"]$/g, "") ?? null,
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
