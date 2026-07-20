import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, basename, resolve } from "node:path";
import type { AppContext } from "../../server.js";
import type { ProjectConfig } from "../../../types.js";
import { jsonError, jsonResult, resolveProjectPath, sha256 } from "../dev/common.js";

const NOTES_DIR = "public/notes";
const INDEX_PATH = "public/index.html";
const DATABASES_DIR = "public/databases";
const GUIDELINES = `Private Notes は、ChatGPT と人間が同じ HTML を見るための private HTML note site。

必ず守ること:
- 最初に private_notes.guidelines を読む。
- private_notes tool は registry の private-notes または LOCAL_DEV_MCP_PRIVATE_NOTES_ROOT を自動解決する。
- 正本は public/notes/*.html。
- public/index.html は note files から生成される面として扱う。
- public/databases/*.html は build/validate で生成されるデータベースページ。
- project ごとに public/notes/<project-slug>/*.html へ分けてよい。
- 各 note の head に <meta name="private-notes" data-project data-type data-status data-tags data-parent> を置く。
- data-project は project grouping。省略時は public/notes/ 配下の最初の path segment を使う。
- data-parent は親 note id、つまり .html を除いた note path。例: makeitmine/index。
- 新規 note は private_notes.create を使う。
- 手編集した場合も最後に private_notes.validate を呼ぶ。
- deploy はユーザーが明示したときだけ行う。
- Cloudflare Access の read-back なしに「公開面が private」と断定しない。
- secret、token、credential、OAuth callback、支払い情報、review account password は書かない。`;

type CreateArgs = {
  title?: string;
  body_html?: string;
  slug?: string;
  date?: string;
  project?: string;
  type?: string;
  status?: string;
  tags?: string[];
  parent?: string;
  pinned?: boolean;
  overwrite?: boolean;
};

type ValidateArgs = { path?: string };

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function attr(html: string, name: string): string {
  const match = html.match(new RegExp(`\\s${name}="([^"]*)"`, "i"));
  return match ? match[1].trim() : "";
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function projectLabel(value: string): string {
  return value || "General";
}

async function listHtmlFiles(rootDir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(rootDir, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listHtmlFiles(rootDir, relative));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(relative);
    }
  }
  return files.sort();
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function projectFromEnvRoot(root: string): ProjectConfig {
  const absoluteRoot = resolve(root);
  return {
    projectId: "private-notes",
    displayName: "Private Notes",
    hostRoot: absoluteRoot,
    sandboxRoot: absoluteRoot,
    sandboxType: "host",
    defaultShell: "/bin/bash",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
    networkPolicy: "ask",
    writePolicy: "confirm",
    approvalMode: "policy",
    deniedPaths: [".env", ".env.*", ".npmrc", ".wrangler", "node_modules", "secrets", "credentials"],
    redactionProfile: "default",
  };
}

async function ensurePrivateNotesProject(project: ProjectConfig) {
  const packagePath = resolveProjectPath(project, "package.json");
  if (!packagePath.ok) return jsonError(packagePath.code, packagePath.message);
  const notesPath = resolveProjectPath(project, NOTES_DIR, { allowDirectory: true });
  if (!notesPath.ok) return jsonError(notesPath.code, notesPath.message);
  const wranglerPath = resolveProjectPath(project, "wrangler.toml");
  if (!wranglerPath.ok) return jsonError(wranglerPath.code, wranglerPath.message);

  if (!existsSync(packagePath.absolutePath) || !existsSync(notesPath.absolutePath) || !existsSync(wranglerPath.absolutePath)) {
    return jsonError("NOT_PRIVATE_NOTES_PROJECT", "Selected project does not look like a private-notes site.", {
      required_paths: ["package.json", "wrangler.toml", NOTES_DIR],
      selected_project: project.projectId,
    });
  }

  const packageJson = JSON.parse(await readFile(packagePath.absolutePath, "utf8")) as { name?: unknown };
  if (packageJson.name !== "private-notes") {
    return jsonError("NOT_PRIVATE_NOTES_PROJECT", "Selected project package.json name must be private-notes.", {
      selected_project: project.projectId,
      package_name: packageJson.name,
    });
  }

  return null;
}

async function resolvePrivateNotesProject(ctx: AppContext): Promise<ProjectConfig | ReturnType<typeof jsonError>> {
  const envRoot = process.env.LOCAL_DEV_MCP_PRIVATE_NOTES_ROOT?.trim();
  if (envRoot) {
    const project = projectFromEnvRoot(envRoot);
    const error = await ensurePrivateNotesProject(project);
    return error ?? project;
  }

  const direct = ctx.registry.get("private-notes");
  if (direct) {
    const error = await ensurePrivateNotesProject(direct);
    return error ?? direct;
  }

  for (const project of ctx.registry.getAll()) {
    const error = await ensurePrivateNotesProject(project);
    if (!error) return project;
  }

  return jsonError("PRIVATE_NOTES_PROJECT_NOT_FOUND", "private_notes tools could not find the private-notes project. Register project_id=private-notes or set LOCAL_DEV_MCP_PRIVATE_NOTES_ROOT.", {
    expected_project_id: "private-notes",
    expected_env: "LOCAL_DEV_MCP_PRIVATE_NOTES_ROOT",
    available_projects: ctx.registry.getAll().map((project) => project.projectId),
  });
}

function getTitle(html: string, fallback: string): string {
  const h1 = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  if (h1) return stripTags(h1[1]);

  const title = html.match(/<title[^>]*>(.*?)<\/title>/is);
  if (title) return stripTags(title[1]).replace(/\s+-\s+Private Notes\s*$/i, "").trim();

  return fallback;
}

function getDate(html: string): string {
  const datetime = html.match(/<time[^>]*datetime="([^"]+)"/i);
  if (datetime) return datetime[1];

  const eyebrow = html.match(/<p[^>]*class="eyebrow"[^>]*>\s*([^<]+)\s*<\/p>/i);
  if (eyebrow && isIsoDate(eyebrow[1].trim())) return eyebrow[1].trim();

  return "";
}

function readMeta(html: string, file = "") {
  const metaMatch = html.match(/<meta\s+name="private-notes"([^>]*)>/i);
  const metaAttrs = metaMatch?.[1] ?? "";
  const pathProject = file.includes("/") ? file.split("/")[0] : "";
  return {
    hasMeta: Boolean(metaMatch),
    parent: attr(metaAttrs, "data-parent"),
    project: attr(metaAttrs, "data-project") || pathProject || "general",
    type: attr(metaAttrs, "data-type") || "note",
    status: attr(metaAttrs, "data-status"),
    tags: splitList(attr(metaAttrs, "data-tags")),
    pinned: attr(metaAttrs, "data-pinned") === "true",
  };
}

type NoteEntry = {
  id: string;
  file: string;
  href: string;
  title: string;
  date: string;
  hasMeta: boolean;
  parent: string;
  project: string;
  type: string;
  status: string;
  tags: string[];
  pinned: boolean;
};

function databaseHref(project: string): string {
  return `/databases/${encodeURIComponent(project)}.html`;
}

function renderBadges(note: NoteEntry): string {
  const badges = [projectLabel(note.project), note.status, ...note.tags.slice(0, 3)]
    .filter(Boolean)
    .map((item) => `<span class="badge">${escapeHtml(item)}</span>`)
    .join("");
  return badges ? `<span class="badges">${badges}</span>` : "";
}

function renderNoteList(notes: NoteEntry[], options: { className?: string } = {}): string {
  const items = notes
    .map((note) => {
      const date = note.date
        ? `<time datetime="${escapeHtml(note.date)}">${escapeHtml(note.date)}</time>`
        : `<span>${escapeHtml(note.type)}</span>`;
      return `          <li>
            <a href="${escapeHtml(note.href)}">
              <span>
                <strong>${escapeHtml(note.title)}</strong>
                ${renderBadges(note)}
              </span>
              ${date}
            </a>
          </li>`;
    })
    .join("\n");
  return `<ul class="${options.className || "note-list"}">
${items}
        </ul>`;
}

function renderTree(notes: NoteEntry[]): string {
  const byParent = new Map<string, NoteEntry[]>();
  for (const note of notes) {
    const key = note.parent || "";
    byParent.set(key, [...(byParent.get(key) || []), note]);
  }

  function branch(parent: string, depth = 0): string {
    const children = (byParent.get(parent) || []).sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
    if (children.length === 0) return "";
    const items = children.map((note) => {
      const nested = branch(note.id, depth + 1);
      return `          <li>
            <a href="${escapeHtml(note.href)}">
              <span>${escapeHtml(note.title)}</span>
              <small>${escapeHtml(note.type)}</small>
            </a>
${nested}
          </li>`;
    }).join("\n");
    return `<ul class="${depth === 0 ? "page-tree" : "page-tree nested"}">
${items}
        </ul>`;
  }

  return branch("");
}

function renderDatabase(notes: NoteEntry[]): string {
  const rows = notes.map((note) => `          <tr>
            <td><a href="${escapeHtml(note.href)}">${escapeHtml(note.title)}</a></td>
            <td>${escapeHtml(projectLabel(note.project))}</td>
            <td>${escapeHtml(note.type)}</td>
            <td>${escapeHtml(note.status)}</td>
            <td>${escapeHtml(note.tags.join(", "))}</td>
            <td>${escapeHtml(note.date)}</td>
          </tr>`).join("\n");
  return `<div class="table-wrap">
        <table class="database">
          <thead>
            <tr>
              <th>Name</th>
              <th>Project</th>
              <th>Type</th>
              <th>Status</th>
              <th>Tags</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`;
}

function groupByProject(notes: NoteEntry[]): Array<[string, NoteEntry[]]> {
  const groups = new Map<string, NoteEntry[]>();
  for (const note of notes) {
    const key = note.project || "general";
    groups.set(key, [...(groups.get(key) || []), note]);
  }
  return [...groups.entries()].sort(([a], [b]) => projectLabel(a).localeCompare(projectLabel(b)));
}

function renderProjects(notes: NoteEntry[]): string {
  const cards = groupByProject(notes).map(([project, projectNotes]) => {
    const latest = projectNotes.find((note) => note.date)?.date || "";
    const pinned = projectNotes.filter((note) => note.pinned).length;
    return `          <a class="project-card" href="#project-${escapeHtml(project)}">
            <span>
              <strong>${escapeHtml(projectLabel(project))}</strong>
              <small>${projectNotes.length} page${projectNotes.length === 1 ? "" : "s"}${pinned ? ` / ${pinned} pinned` : ""}</small>
            </span>
            ${latest ? `<time datetime="${escapeHtml(latest)}">${escapeHtml(latest)}</time>` : "<span></span>"}
          </a>`;
  }).join("\n");
  return `<div class="project-grid">
${cards}
        </div>`;
}

function renderExplorer(notes: NoteEntry[]): string {
  const folders = groupByProject(notes).map(([project, projectNotes]) => `            <li>
              <a href="#folder-${escapeHtml(project)}">
                <span>${escapeHtml(projectLabel(project))}</span>
                <small>${projectNotes.length}</small>
              </a>
              <a class="sub-link" href="${escapeHtml(databaseHref(project))}">Database</a>
            </li>`).join("\n");

  const sections = groupByProject(notes).map(([project, projectNotes]) => {
    const recent = projectNotes.slice(0, 8);
    return `          <section class="folder-panel" id="folder-${escapeHtml(project)}">
            <header class="folder-header">
              <div>
                <p class="eyebrow">${escapeHtml(String(projectNotes.length))} pages</p>
                <h2>${escapeHtml(projectLabel(project))}</h2>
              </div>
              <a class="text-button" href="${escapeHtml(databaseHref(project))}">Open database</a>
            </header>
            <div class="folder-columns">
              <div>
                <h3>Tree</h3>
                ${renderTree(projectNotes)}
              </div>
              <div>
                <h3>Recent</h3>
                ${renderNoteList(recent, { className: "note-list compact" })}
              </div>
            </div>
          </section>`;
  }).join("\n");

  return `<div class="explorer">
        <aside class="explorer-sidebar">
          <a class="root-link" href="/databases/all.html">All notes database</a>
          <h2>Folders</h2>
          <ul>
${folders}
          </ul>
        </aside>
        <div class="explorer-main">
${sections}
        </div>
      </div>`;
}

function renderProjectSections(notes: NoteEntry[]): string {
  const sections = groupByProject(notes).map(([project, projectNotes]) => {
    const recent = projectNotes.slice(0, 6);
    return `      <section class="project-section" id="project-${escapeHtml(project)}">
        <header>
          <p class="eyebrow">${escapeHtml(String(projectNotes.length))} pages</p>
          <h2>${escapeHtml(projectLabel(project))}</h2>
        </header>
        <div class="project-columns">
          <div>
            <h3>Pages</h3>
            ${renderTree(projectNotes)}
          </div>
          <div>
            <h3>Recent</h3>
            ${renderNoteList(recent, { className: "note-list compact" })}
          </div>
        </div>
      </section>`;
  }).join("\n");
  return `<div class="project-sections">
${sections}
      </div>`;
}

function applyViews(html: string, notes: NoteEntry[]): string {
  return html.replace(/<section([^>]*)data-view="([^"]+)"([^>]*)>\s*<\/section>/gi, (_match, before, view, after) => {
    const attrs = `${before} ${after}`;
    const title = attr(attrs, "data-title");
    const parent = attr(attrs, "data-parent");
    const project = attr(attrs, "data-project");
    const type = attr(attrs, "data-type");
    const tag = attr(attrs, "data-tag");
    const status = attr(attrs, "data-status");
    const limit = Number.parseInt(attr(attrs, "data-limit"), 10);

    let filtered = notes;
    if (parent) filtered = filtered.filter((note) => note.parent === parent);
    if (project) filtered = filtered.filter((note) => note.project === project);
    if (type) filtered = filtered.filter((note) => note.type === type);
    if (tag) filtered = filtered.filter((note) => note.tags.includes(tag));
    if (status) filtered = filtered.filter((note) => note.status === status);
    if (Number.isFinite(limit) && limit > 0) filtered = filtered.slice(0, limit);

    const body = view === "explorer"
      ? renderExplorer(notes)
      : view === "projects"
      ? renderProjects(notes)
      : view === "project-sections"
        ? renderProjectSections(notes)
        : view === "tree"
          ? renderTree(filtered)
          : view === "database"
            ? renderDatabase(filtered)
            : renderNoteList(filtered);

    return `<section class="section" data-view="${escapeHtml(view)}">
        ${title ? `<h2>${escapeHtml(title)}</h2>` : ""}
        ${body}
      </section>`;
  });
}

function pageShell(args: { title: string; lede?: string; body: string; className?: string }): string {
  const className = args.className ?? "dashboard";
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(args.title)} - Private Notes</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="shell ${escapeHtml(className)}">
      <nav class="top-nav"><a href="/">Private Notes</a></nav>
      <header class="page-header">
        <p class="eyebrow">Database</p>
        <h1>${escapeHtml(args.title)}</h1>
        ${args.lede ? `<p class="lede">${escapeHtml(args.lede)}</p>` : ""}
      </header>

${args.body}
    </main>
  </body>
</html>
`;
}

async function writeDatabasePages(projectRoot: string, notes: NoteEntry[]) {
  const databaseRoot = join(projectRoot, DATABASES_DIR);
  await rm(databaseRoot, { recursive: true, force: true });
  await mkdir(databaseRoot, { recursive: true });

  await writeFile(
    join(databaseRoot, "all.html"),
    pageShell({
      title: "All Notes",
      lede: "すべてのメモを横断して確認するデータベース。",
      body: `      ${renderDatabase(notes)}`,
    }),
    "utf8",
  );

  await Promise.all(groupByProject(notes).map(([project, projectNotes]) => writeFile(
    join(databaseRoot, `${encodeURIComponent(project)}.html`),
    pageShell({
      title: `${projectLabel(project)} Database`,
      lede: `${projectLabel(project)} に属するメモだけを表示するデータベース。`,
      body: `      ${renderDatabase(projectNotes)}`,
    }),
    "utf8",
  )));
}

async function buildIndex(projectRoot: string) {
  const notesRoot = join(projectRoot, NOTES_DIR);
  const files = await listHtmlFiles(notesRoot);
  const notes = await Promise.all(files.map(async (file) => {
    const html = await readFile(join(notesRoot, file), "utf8");
    const fallback = basename(file, ".html").replaceAll("-", " ");
    const meta = readMeta(html, file);
    return {
      id: file.replace(/\.html$/i, ""),
      file,
      href: `/notes/${file}`,
      title: getTitle(html, fallback),
      date: getDate(html),
      ...meta,
    };
  }));

  notes.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const dateCompare = b.date.localeCompare(a.date);
    if (dateCompare !== 0) return dateCompare;
    return a.title.localeCompare(b.title);
  });

  const html = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Private Notes</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="shell dashboard">
      <header class="page-header">
        <p class="eyebrow">ChatGPT / Human Shared HTML</p>
        <h1>Private Notes</h1>
        <p class="lede">プロジェクト別に分けて、HTML の自由度を保ったまま参照できる個人用メモ置き場。</p>
      </header>

      <section data-view="explorer"></section>
    </main>
  </body>
</html>
`;

  await writeDatabasePages(projectRoot, notes);
  await writeFile(join(projectRoot, INDEX_PATH), applyViews(html, notes), "utf8");
  return notes;
}

export async function handlePrivateNotesGuidelines() {
  return jsonResult({
    title: "Private Notes operating guidelines",
    text: GUIDELINES,
    workflow: [
      "private_notes.guidelines",
      "private_notes.create or workspace.patch under public/notes",
      "private_notes.validate",
      "deploy only on explicit request",
    ],
  });
}

export async function handlePrivateNotesCreate(ctx: AppContext, chatContextId: string, args: CreateArgs) {
  void chatContextId;
  const project = await resolvePrivateNotesProject(ctx);
  if ("isError" in project) return project;

  const title = args?.title?.trim();
  if (!title) return jsonError("MISSING_TITLE", "private_notes.create requires a title.");
  const bodyHtml = args.body_html?.trim();
  if (!bodyHtml) return jsonError("MISSING_BODY_HTML", "private_notes.create requires body_html reviewed in chat before writing.");
  const date = args.date?.trim() || todayIsoDate();
  if (!isIsoDate(date)) return jsonError("INVALID_DATE", "date must use YYYY-MM-DD.");

  const slug = slugify(args.slug?.trim() || title);
  if (!slug) return jsonError("INVALID_SLUG", "Could not create a URL-safe slug from the title or slug.");
  const projectSlug = args.project?.trim() ? slugify(args.project.trim()) : "";
  if (args.project?.trim() && !projectSlug) return jsonError("INVALID_PROJECT", "Could not create a URL-safe project slug.");

  const relativePath = projectSlug
    ? `${NOTES_DIR}/${projectSlug}/${date}-${slug}.html`
    : `${NOTES_DIR}/${date}-${slug}.html`;
  const resolved = resolveProjectPath(project, relativePath);
  if (!resolved.ok) return jsonError(resolved.code, resolved.message);

  const overwrite = args.overwrite === true;
  if (existsSync(resolved.absolutePath) && !overwrite) {
    return jsonError("NOTE_ALREADY_EXISTS", "A private note with this slug already exists. Pass overwrite=true to replace it.", {
      path: resolved.relativePath,
    });
  }

  const safeTitle = escapeHtml(title);
  const safeProject = escapeHtml(projectSlug || "general");
  const safeType = escapeHtml(args.type?.trim() || "note");
  const safeStatus = escapeHtml(args.status?.trim() || "draft");
  const safeTags = escapeHtml((args.tags || []).map((tag) => tag.trim()).filter(Boolean).join(","));
  const safeParent = escapeHtml(args.parent?.trim() || "");
  const safePinned = args.pinned === true ? "true" : "false";
  const html = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle} - Private Notes</title>
    <meta name="private-notes" data-project="${safeProject}" data-type="${safeType}" data-status="${safeStatus}" data-tags="${safeTags}" data-parent="${safeParent}" data-pinned="${safePinned}" />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="shell note">
      <nav class="top-nav"><a href="/">Notes</a></nav>
      <article>
        <header class="page-header">
          <p class="eyebrow">${date}</p>
          <h1>${safeTitle}</h1>
        </header>

${bodyHtml}
      </article>
    </main>
  </body>
</html>
`;

  await mkdir(dirname(resolved.absolutePath), { recursive: true });
  await writeFile(resolved.absolutePath, html, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
  const notes = await buildIndex(project.hostRoot);

  return jsonResult({
    created: true,
    overwritten: overwrite,
    project_id: project.projectId,
    path: resolved.relativePath,
    index_path: INDEX_PATH,
    note_count: notes.length,
    sha256: sha256(html),
    warnings: ["Cloudflare Access privacy is not verified by this tool."],
  });
}

export async function handlePrivateNotesValidate(ctx: AppContext, chatContextId: string, args: ValidateArgs) {
  void chatContextId;
  const project = await resolvePrivateNotesProject(ctx);
  if ("isError" in project) return project;

  const target = args?.path?.trim() || NOTES_DIR;
  const resolved = resolveProjectPath(project, target, { allowDirectory: true });
  if (!resolved.ok) return jsonError(resolved.code, resolved.message);
  if (resolved.relativePath !== NOTES_DIR && !resolved.relativePath.startsWith(`${NOTES_DIR}/`)) {
    return jsonError("PATH_OUTSIDE_PRIVATE_NOTES", `private_notes.validate can only inspect ${NOTES_DIR}.`);
  }

  const notes = await buildIndex(project.hostRoot);
  const indexText = await readFile(join(project.hostRoot, INDEX_PATH), "utf8");
  const issues = [];
  for (const note of notes) {
    if (!indexText.includes(`/notes/${note.file}`)) {
      issues.push({ path: `${NOTES_DIR}/${note.file}`, code: "MISSING_INDEX_LINK", message: "Note is not linked from public/index.html." });
    }
    if (!note.title) {
      issues.push({ path: `${NOTES_DIR}/${note.file}`, code: "MISSING_TITLE", message: "Note should have an h1 or title." });
    }
    if (!note.date) {
      issues.push({ path: `${NOTES_DIR}/${note.file}`, code: "MISSING_DATE", message: "Note should include a YYYY-MM-DD date in .eyebrow or time[datetime]." });
    }
    if (!note.hasMeta) {
      issues.push({ path: `${NOTES_DIR}/${note.file}`, code: "MISSING_PRIVATE_NOTES_META", message: "Note should include <meta name=\"private-notes\" ...> in head." });
    }
  }

  return jsonResult({
    project_id: project.projectId,
    root: NOTES_DIR,
    index_path: INDEX_PATH,
    total_notes: notes.length,
    valid: issues.length === 0,
    notes: notes.map((note) => ({
      path: `${NOTES_DIR}/${note.file}`,
      title: note.title,
      date: note.date || null,
      project: note.project,
      type: note.type,
      status: note.status || null,
      tags: note.tags,
      parent: note.parent || null,
    })),
    issues,
    privacy: {
      cloudflare_access_verified: false,
      note: "This tool validates local source only. Deployed privacy requires Cloudflare Access read-back.",
    },
  });
}
