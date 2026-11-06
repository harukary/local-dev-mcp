import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { redactOutput } from "../shell/redactor.js";

export type FeedbackKind = "bug" | "improvement" | "missing_feature";
export type FeedbackStatus = "open" | "in_progress" | "resolved" | "dismissed";
export type FeedbackSource = "chatgpt" | "claude" | "muse";

export type FeedbackItem = {
  id: string;
  kind: FeedbackKind;
  title: string;
  description: string;
  impact?: string;
  suggestion?: string;
  related_tool?: string;
  project_id?: string;
  sources: FeedbackSource[];
  status: FeedbackStatus;
  occurrences: number;
  reopened: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  resolved_at?: string;
  latest_note?: string;
  resolution?: string;
};

export type FeedbackReport = Pick<FeedbackItem, "kind" | "title" | "description"> &
  Partial<Pick<FeedbackItem, "impact" | "suggestion" | "related_tool" | "project_id">> & {
    existing_id?: string;
    source: FeedbackSource;
  };

export type FeedbackUpdate = { id: string; status?: FeedbackStatus; note?: string; resolution?: string };
export type FeedbackQuery = {
  status?: "active" | FeedbackStatus | "all";
  kind?: FeedbackKind;
  project_id?: string;
  recent_days?: number;
  limit?: number;
  offset?: number;
};

type Persisted = { version: 1; items: FeedbackItem[] };

const CLOSED: FeedbackStatus[] = ["resolved", "dismissed"];

function issueKey(item: Pick<FeedbackItem, "project_id" | "kind" | "related_tool" | "title">): string {
  return JSON.stringify([item.project_id ?? null, item.kind, item.related_tool ?? null,
    item.title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en")]);
}

// Report fields contain summaries, not raw logs. Mask common credentials even if an agent
// accidentally includes them; no tool arguments or tool outputs are collected automatically.
export function safeFeedbackText(value: string): string {
  return redactOutput(value.trim(), "strict").text.replace(
    /([?&](?:token|access_token|api_key|secret|password)=)[^&#\s]+/gi,
    "$1[REDACTED]",
  );
}

function isItem(value: unknown): value is FeedbackItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<FeedbackItem>;
  return typeof v.id === "string" && ["bug", "improvement", "missing_feature"].includes(v.kind ?? "") &&
    typeof v.title === "string" && typeof v.description === "string" &&
    ["open", "in_progress", "resolved", "dismissed"].includes(v.status ?? "") &&
    Array.isArray(v.sources) && v.sources.every((source) => ["chatgpt", "claude", "muse"].includes(source)) &&
    Number.isSafeInteger(v.occurrences) && (v.occurrences ?? 0) > 0 &&
    Number.isSafeInteger(v.reopened) && (v.reopened ?? -1) >= 0 &&
    typeof v.created_at === "string" && typeof v.updated_at === "string" && typeof v.last_seen_at === "string";
}

export class FeedbackStore {
  private items: FeedbackItem[] = [];
  private pending: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<FeedbackStore> {
    const store = new FeedbackStore(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return store;
      throw error;
    }
    if (!info.isFile()) throw new Error("Feedback store must be a regular file.");
    await chmod(path, 0o600);
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid feedback store.");
    const data = parsed as Partial<Persisted>;
    if (data.version !== 1 || !Array.isArray(data.items) || !data.items.every(isItem)) {
      throw new Error("Invalid feedback store.");
    }
    store.items = data.items;
    return store;
  }

  private async save(next: FeedbackItem[]): Promise<void> {
    const temporary = `${this.path}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, items: next } satisfies Persisted), {
        encoding: "utf8", mode: 0o600, flag: "wx",
      });
      await rename(temporary, this.path);
      this.items = next;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const running = this.pending.then(task, task);
    this.pending = running.then(() => undefined, () => undefined);
    return running;
  }

  async report(input: FeedbackReport): Promise<{ created: boolean; reopened: boolean; item: FeedbackItem }> {
    return await this.serialize(async () => {
      const now = new Date().toISOString();
      const report: FeedbackItem = {
        id: `fb_${randomUUID()}`,
        kind: input.kind,
        title: safeFeedbackText(input.title),
        description: safeFeedbackText(input.description),
        ...(input.impact ? { impact: safeFeedbackText(input.impact) } : {}),
        ...(input.suggestion ? { suggestion: safeFeedbackText(input.suggestion) } : {}),
        ...(input.related_tool ? { related_tool: input.related_tool } : {}),
        ...(input.project_id ? { project_id: input.project_id } : {}),
        sources: [input.source],
        status: "open",
        occurrences: 1,
        reopened: 0,
        created_at: now,
        updated_at: now,
        last_seen_at: now,
      };
      const previous = input.existing_id
        ? this.items.find((item) => item.id === input.existing_id)
        : this.items.find((item) => issueKey(item) === issueKey(report));
      if (input.existing_id && !previous) throw new Error("FEEDBACK_NOT_FOUND");
      if (previous && (previous.kind !== report.kind || (report.project_id !== undefined && previous.project_id !== report.project_id))) {
        throw new Error("FEEDBACK_MISMATCH");
      }
      if (!previous && this.items.length >= 5000) throw new Error("FEEDBACK_STORE_FULL");
      const reopened = previous !== undefined && CLOSED.includes(previous.status);
      const item = previous
        ? {
          ...previous,
          sources: [...new Set([...previous.sources, input.source])],
          occurrences: previous.occurrences + 1,
          reopened: previous.reopened + Number(reopened),
          status: reopened ? "open" as const : previous.status,
          updated_at: now,
          last_seen_at: now,
          ...(reopened ? { resolved_at: undefined } : {}),
        }
        : report;
      await this.save(previous
        ? this.items.map((candidate) => candidate.id === previous.id ? item : candidate)
        : [...this.items, item]);
      return { created: !previous, reopened, item };
    });
  }

  async update(input: FeedbackUpdate): Promise<FeedbackItem> {
    return await this.serialize(async () => {
      const previous = this.items.find((item) => item.id === input.id);
      if (!previous) throw new Error("FEEDBACK_NOT_FOUND");
      const now = new Date().toISOString();
      const status = input.status ?? previous.status;
      if (input.status && CLOSED.includes(input.status) && !CLOSED.includes(previous.status) && !input.resolution) {
        throw new Error("FEEDBACK_RESOLUTION_REQUIRED");
      }
      const wasReopened = CLOSED.includes(previous.status) && !CLOSED.includes(status);
      const item: FeedbackItem = {
        ...previous,
        status,
        reopened: previous.reopened + Number(wasReopened),
        updated_at: now,
        ...(input.note === undefined ? {} : { latest_note: safeFeedbackText(input.note) }),
        ...(input.resolution === undefined ? {} : { resolution: safeFeedbackText(input.resolution) }),
        ...(CLOSED.includes(status) && !CLOSED.includes(previous.status) ? { resolved_at: now } : {}),
        ...(!CLOSED.includes(status) ? { resolved_at: undefined } : {}),
      };
      await this.save(this.items.map((candidate) => candidate.id === previous.id ? item : candidate));
      return item;
    });
  }

  async list(query: FeedbackQuery = {}): Promise<{ total: number; items: FeedbackItem[]; has_more: boolean; next_offset: number | null }> {
    await this.pending;
    const since = query.recent_days === undefined ? undefined : Date.now() - query.recent_days * 86_400_000;
    const status = query.status ?? "active";
    const filtered = this.items.filter((item) =>
      (status === "all" || status === "active" && !CLOSED.includes(item.status) || item.status === status) &&
      (!query.kind || item.kind === query.kind) &&
      (!query.project_id || item.project_id === query.project_id) &&
      (since === undefined || Date.parse(item.updated_at) >= since)
    ).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    const items = filtered.slice(offset, offset + limit);
    const has_more = offset + items.length < filtered.length;
    return { total: filtered.length, items, has_more, next_offset: has_more ? offset + items.length : null };
  }
}
