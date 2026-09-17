// openclaw-obsidian-export
// Port of the OpenCode "opencode-obsidian-export" plugin to OpenClaw.
//
// Two surfaces, one plugin:
//   1. AUTO TRANSCRIPT  — on `session_end` (every reason), dump the full raw
//      session transcript (messages + tool calls) to a markdown note. This is
//      a pure local data dump: NO LLM call, ZERO tokens.
//   2. ON-DEMAND SUMMARY — the `export_to_obsidian` tool. The *running* agent
//      authors the `summary` argument itself, so no hidden/extra model call is
//      made; tokens are only spent when the user explicitly asks for a summary.
//
// Notes land in ONE shared folder for ALL agents (default:
// ~/Brain/_Shared_Systems/Openclaw), filenames:
//   "<hostname> - <session name> - Transcript.md"
//   "<hostname> - <session name> - Summary.md"

import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile, appendFile, unlink } from "node:fs/promises";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { Type } from "typebox";

const PKG_NAME = "openclaw-obsidian-export";
const PKG_VERSION = "1.0.0";

const DEFAULT_VAULT_SUBDIR = "_Shared_Systems/Openclaw";

// ─── Config ──────────────────────────────────────────────────────────────
// Resolved from the plugin config snapshot (plugins.entries.<id>.config) with
// env-var fallback so it works before config is wired up.
interface ResolvedConfig {
  outputDir: string;
  userName: string;
  assistantName: string;
  sessionPrefix: string;
  transcriptFilenameFormat: string;
  summaryFilenameFormat: string;
}

function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

function resolveConfig(pluginConfig: Record<string, unknown> | undefined): ResolvedConfig {
  const cfg = pluginConfig ?? {};
  const str = (k: string, env: string, dflt: string): string => {
    const v = cfg[k];
    if (typeof v === "string" && v.trim()) return v;
    const e = process.env[env];
    if (typeof e === "string" && e.trim()) return e;
    return dflt;
  };

  // outputDir precedence: config.outputDir > OBSIDIAN_OPENCLAW_DIR >
  // ($OBSIDIAN_VAULT_PATH || ~/Brain)/_Shared_Systems/Openclaw
  let outputDir = "";
  if (typeof cfg.outputDir === "string" && cfg.outputDir.trim()) {
    outputDir = cfg.outputDir;
  } else if (process.env.OBSIDIAN_OPENCLAW_DIR) {
    outputDir = process.env.OBSIDIAN_OPENCLAW_DIR;
  } else {
    const vault = process.env.OBSIDIAN_VAULT_PATH || path.join(os.homedir(), "Brain");
    outputDir = path.join(vault, DEFAULT_VAULT_SUBDIR);
  }
  outputDir = expandHome(outputDir);

  return {
    outputDir,
    userName: str("userName", "OPENCLAW_USER_NAME", "You"),
    assistantName: str("assistantName", "OPENCLAW_ASSISTANT_NAME", "Assistant"),
    sessionPrefix: str("sessionPrefix", "OPENCLAW_SESSION_PREFIX", "Session"),
    transcriptFilenameFormat: str(
      "transcriptFilenameFormat",
      "OPENCLAW_TRANSCRIPT_FORMAT",
      "{hostname} - {title} - Transcript",
    ),
    summaryFilenameFormat: str(
      "summaryFilenameFormat",
      "OPENCLAW_SUMMARY_FORMAT",
      "{hostname} - {title} - Summary",
    ),
  };
}

// ─── Silent logging (to file, never stdout/stderr) ─────────────────────────
async function logToFile(dir: string, message: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${message}\n`;
    await appendFile(path.join(dir, ".plugin.log"), line, "utf-8");
  } catch {
    // Never throw from logging.
  }
}

// ─── Filename helpers ──────────────────────────────────────────────────────
function shortHostname(): string {
  return os.hostname().split(".")[0];
}

function sanitizeTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 60);
}

function buildFilename(
  format: string,
  tokens: Record<string, string>,
): string {
  let name = format.replace(
    /\{(date|hostname|title|sessionId)\}/g,
    (_m, k: string) => tokens[k] ?? "",
  );
  name = name.replace(/\s{2,}/g, " ").replace(/^[\s-]+|[\s-]+$/g, "").trim();
  if (!name) name = tokens.title || tokens.sessionId || "session";
  if (!name.toLowerCase().endsWith(".md")) name += ".md";
  return name;
}

// ─── Transcript-event model ────────────────────────────────────────────────
// Raw events from readSessionTranscriptEvents have shape:
//   { type: "message" | "compaction" | "reset" | ..., id, parentId, timestamp,
//     message?: { role, content: Block[] } }
// Content blocks: { type } where type (lowercased) ∈
//   text | thinking | toolcall/tooluse/functioncall | toolresult | ...
interface RawEvent {
  type?: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  message?: RawMessage;
  [k: string]: unknown;
}
interface RawMessage {
  role?: string;
  content?: unknown;
  [k: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function blockType(block: unknown): string {
  if (!isRecord(block)) return "";
  return typeof block.type === "string" ? block.type.trim().toLowerCase() : "";
}

function blockText(block: Record<string, unknown>): string {
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  return "";
}

function messageText(message: RawMessage): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (blockType(block) === "text" && isRecord(block)) {
      const t = blockText(block);
      if (t) parts.push(t);
    }
  }
  return parts.join("\n\n").trim();
}

function messageToolNotes(message: RawMessage): string[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const notes: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const bt = blockType(block);
    if (bt === "toolcall" || bt === "tooluse" || bt === "functioncall") {
      const name =
        (typeof block.name === "string" && block.name) ||
        (typeof block.toolName === "string" && block.toolName) ||
        "tool";
      const args = block.arguments ?? block.input ?? block.parameters;
      let argStr = "";
      try {
        argStr = args !== undefined ? JSON.stringify(args) : "";
      } catch {
        argStr = "";
      }
      notes.push(`> 🔧 tool: \`${name}\` ${argStr}`.trim());
    } else if (bt === "toolresult") {
      const result = block.result ?? block.output ?? block.content;
      let rStr = "";
      try {
        rStr = typeof result === "string" ? result : JSON.stringify(result);
      } catch {
        rStr = "";
      }
      if (rStr) notes.push(`> ↩️ result: ${truncate(rStr, 2000)}`);
    }
  }
  return notes;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + " …[truncated]" : s;
}

// ─── Deterministic agent-context extraction (no LLM) ───────────────────────
const FILE_ARG_KEYS = ["filePath", "path", "file"];

function extractGoal(events: RawEvent[]): string {
  for (const ev of events) {
    if (ev.type !== "message" || !ev.message) continue;
    if (ev.message.role !== "user") continue;
    const text = messageText(ev.message);
    if (text) return text.slice(0, 400);
  }
  return "";
}

function toolCallsOf(message: RawMessage): Array<{ name: string; args: unknown }> {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ name: string; args: unknown }> = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const bt = blockType(block);
    if (bt === "toolcall" || bt === "tooluse" || bt === "functioncall") {
      const name =
        (typeof block.name === "string" && block.name) ||
        (typeof block.toolName === "string" && block.toolName) ||
        "tool";
      out.push({ name, args: block.arguments ?? block.input ?? block.parameters });
    }
  }
  return out;
}

function extractFilesTouched(events: RawEvent[]): string[] {
  const files = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "message" || !ev.message) continue;
    for (const call of toolCallsOf(ev.message)) {
      if (!isRecord(call.args)) continue;
      for (const k of FILE_ARG_KEYS) {
        const v = call.args[k];
        if (typeof v === "string") files.add(v);
      }
    }
  }
  return [...files];
}

function extractToolUsage(events: RawEvent[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const ev of events) {
    if (ev.type !== "message" || !ev.message) continue;
    for (const call of toolCallsOf(ev.message)) {
      counts.set(call.name, (counts.get(call.name) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const HIGHLIGHT_PATTERNS: Array<{ tag: string; re: RegExp }> = [
  { tag: "decision", re: /\b(decided|chose|going with|we will|approach:|plan:)\b/i },
  { tag: "gotcha", re: /\b(gotcha|caveat|note that|be careful|important:|warning|caution|beware)\b/i },
  { tag: "todo", re: /\b(todo|follow-?up|next step|remaining|still need|not yet)\b/i },
  { tag: "fix", re: /\b(root cause|the bug|the issue was|fixed by|because)\b/i },
];

function extractHighlights(events: RawEvent[], max = 12): Array<{ tag: string; line: string }> {
  const out: Array<{ tag: string; line: string }> = [];
  for (const ev of events) {
    if (ev.type !== "message" || !ev.message) continue;
    if (ev.message.role !== "assistant") continue;
    const text = messageText(ev.message);
    if (!text) continue;
    for (const raw of text.split(/\n+/)) {
      const line = raw.trim().replace(/^[-*>#\s]+/, "");
      if (line.length < 12 || line.length > 240) continue;
      for (const { tag, re } of HIGHLIGHT_PATTERNS) {
        if (re.test(line)) {
          out.push({ tag, line });
          break;
        }
      }
      if (out.length >= max) return out;
    }
  }
  return out;
}

const YAML_ESCAPE = (s: unknown): string => {
  if (typeof s === "string" && /[:#\-?\[\]{}&*!|>'"%@`\n]/.test(s)) {
    return JSON.stringify(s);
  }
  return String(s ?? "");
};

interface NoteMeta {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  title: string;
  reason?: string;
}

interface RenderOpts {
  summary?: string;
  transcript?: boolean; // false = summary-only note
}

function buildAgentContext(
  events: RawEvent[],
  meta: NoteMeta,
  opts: RenderOpts,
): string {
  const goal = extractGoal(events);
  const files = extractFilesTouched(events);
  const tools = extractToolUsage(events);
  const highlights = extractHighlights(events);
  const summary = typeof opts.summary === "string" ? opts.summary.trim() : "";

  const fm = [
    "---",
    `session_id: ${YAML_ESCAPE(meta.sessionId || "unknown")}`,
    `session_key: ${YAML_ESCAPE(meta.sessionKey || "")}`,
    `title: ${YAML_ESCAPE(meta.title || "")}`,
    `agent: ${YAML_ESCAPE(meta.agentId || "")}`,
    `end_reason: ${YAML_ESCAPE(meta.reason || "")}`,
    `exported: ${new Date().toISOString()}`,
    `hostname: ${YAML_ESCAPE(shortHostname())}`,
    "tags: [openclaw-session, agent-context]",
    "---",
    "",
  ];

  const ctx = ["## 🧭 Agent Context", ""];
  if (goal) ctx.push(`**Goal:** ${goal.replace(/\n/g, " ")}`, "");
  if (summary) ctx.push("### 📝 Summary", "", summary, "");
  if (highlights.length) {
    ctx.push("**Highlights:**");
    for (const h of highlights) ctx.push(`- \`${h.tag}\` — ${h.line}`);
    ctx.push("");
  }
  if (files.length) {
    ctx.push("**Files touched:**");
    for (const f of files.slice(0, 30)) ctx.push(`- \`${f}\``);
    if (files.length > 30) ctx.push(`- …and ${files.length - 30} more`);
    ctx.push("");
  }
  if (tools.length) {
    ctx.push("**Tools used:** " + tools.map(([t, n]) => `${t}×${n}`).join(", "), "");
  }
  ctx.push("---", "");
  return fm.join("\n") + ctx.join("\n");
}

function eventsToMarkdown(
  events: RawEvent[],
  cfg: ResolvedConfig,
  meta: NoteMeta,
  opts: RenderOpts,
): string {
  const lines: string[] = [buildAgentContext(events, meta, opts)];

  // Summary-only notes stop after the Agent Context block.
  if (opts.transcript === false) return lines.join("\n");

  lines.push(
    `# ${cfg.sessionPrefix}: ${meta.title}`,
    "",
    `session_id: ${meta.sessionId}`,
    `exported: ${new Date().toISOString()}`,
    "",
    "---",
    "",
  );

  for (const ev of events) {
    if (ev.type !== "message" || !ev.message) continue;
    const role = ev.message.role || "unknown";
    const text = messageText(ev.message);
    const toolNotes = messageToolNotes(ev.message);
    if (!text && toolNotes.length === 0) continue;

    lines.push(role === "user" ? `## 🧑 ${cfg.userName}` : `## 🤖 ${cfg.assistantName}`);
    if (toolNotes.length) lines.push(...toolNotes, "");
    if (text) lines.push(text);
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Session index (overwrite-not-duplicate) ───────────────────────────────
async function loadIndex(dir: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(path.join(dir, ".session-index.json"), "utf-8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

async function saveIndex(dir: string, index: Record<string, string>): Promise<void> {
  try {
    await writeFile(
      path.join(dir, ".session-index.json"),
      JSON.stringify(index, null, 2),
      "utf-8",
    );
  } catch {
    // ignore
  }
}

// ─── Core write ────────────────────────────────────────────────────────────
async function writeNote(
  cfg: ResolvedConfig,
  events: RawEvent[],
  meta: NoteMeta,
  kind: "Transcript" | "Summary",
  opts: RenderOpts,
  filenameOverride?: string,
): Promise<string> {
  const dir = cfg.outputDir;
  await mkdir(dir, { recursive: true });

  const title = sanitizeTitle(meta.title || meta.sessionId || "session");
  const tokens: Record<string, string> = {
    date: new Date().toISOString().slice(0, 10),
    hostname: shortHostname(),
    title,
    sessionId: meta.sessionId || "",
  };
  const format =
    filenameOverride ||
    (kind === "Summary" ? cfg.summaryFilenameFormat : cfg.transcriptFilenameFormat);
  const filename = buildFilename(format, tokens);
  const fullPath = path.join(dir, filename);

  const markdown = eventsToMarkdown(events, cfg, meta, opts);

  // Overwrite-not-duplicate: if this session+kind was written before under a
  // different filename, remove the stale file first.
  const index = await loadIndex(dir);
  const indexKey = `${meta.sessionId}::${kind}`;
  const prev = index[indexKey];
  if (prev && prev !== filename) {
    try {
      await unlink(path.join(dir, prev));
    } catch {
      // ignore
    }
  }

  await writeFile(fullPath, markdown, "utf-8");
  index[indexKey] = filename;
  await saveIndex(dir, index);

  await logToFile(dir, `wrote ${kind} note: ${filename} (session ${meta.sessionId})`);
  return fullPath;
}

// Derive the agent id from a session key of the form `agent:<id>:...`.
function agentIdFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const m = /^agent:([^:]+):/.exec(sessionKey);
  return m ? m[1] : undefined;
}

async function readTranscriptEvents(
  api: any,
  identity: { agentId?: string; sessionKey?: string; sessionId?: string },
): Promise<RawEvent[]> {
  // The transcript runtime needs an agent id; when it isn't passed explicitly,
  // recover it from the session key (`agent:<id>:...`).
  const agentId = identity.agentId || agentIdFromSessionKey(identity.sessionKey);
  const params: Record<string, unknown> = { config: api.config };
  if (agentId) params.agentId = agentId;
  if (identity.sessionKey) params.sessionKey = identity.sessionKey;
  if (identity.sessionId) params.sessionId = identity.sessionId;
  const events = (await readSessionTranscriptEvents(params as any)) as unknown;
  return Array.isArray(events) ? (events as RawEvent[]) : [];
}

// ─── Plugin entry ──────────────────────────────────────────────────────────
export default definePluginEntry({
  id: "openclaw-obsidian-export",
  name: "Obsidian Export",
  description:
    "Auto-dumps every session transcript to an Obsidian vault (no tokens) and exposes an on-demand summary tool.",
  register(api: any) {
    const cfg = resolveConfig(api.pluginConfig as Record<string, unknown> | undefined);
    api.logger?.info?.(
      `${PKG_NAME}@${PKG_VERSION} → output dir ${cfg.outputDir}`,
    );

    // ── AUTO TRANSCRIPT: on session_end (all reasons), zero tokens ──────────
    api.on(
      "session_end",
      async (event: any, ctx: any) => {
        try {
          const sessionId: string = event?.sessionId || ctx?.sessionId || "";
          const sessionKey: string | undefined = event?.sessionKey || ctx?.sessionKey;
          const agentId: string | undefined = ctx?.agentId;
          if (!sessionId && !sessionKey) return;

          const events = await readTranscriptEvents(api, {
            agentId,
            sessionKey,
            sessionId,
          });
          if (events.length === 0) {
            await logToFile(cfg.outputDir, `session_end: no events for ${sessionId}`);
            return;
          }

          // Derive a human title: first user line, else sessionId.
          const goal = extractGoal(events);
          const title = goal ? goal.split("\n")[0].slice(0, 60) : sessionId;

          await writeNote(
            cfg,
            events,
            { sessionId, sessionKey, agentId, title, reason: event?.reason },
            "Transcript",
            { transcript: true }, // no summary → no LLM/tokens
          );
        } catch (err) {
          await logToFile(
            cfg.outputDir,
            `session_end ERROR: ${(err as Error)?.message ?? err}`,
          );
        }
      },
      { registrationId: "obsidian-export-session-end" },
    );

    // ── ON-DEMAND SUMMARY tool ──────────────────────────────────────────────
    // The running agent authors `summary` itself → no extra model call.
    // Registered as a FACTORY so we receive the OpenClawPluginToolContext
    // (agentId / sessionKey / sessionId / config) for the active run.
    api.registerTool((toolCtx: any) => ({
      name: "export_to_obsidian",
      description:
        "Export the current session to the Obsidian vault as a markdown note. " +
        "IMPORTANT: before calling, WRITE a concise narrative summary of the session " +
        "(goal, what was done, key decisions/gotchas, current state, next steps) and " +
        "pass it as `summary`. Set transcript=false for a summary-only note.",
      parameters: Type.Object({
        summary: Type.Optional(
          Type.String({
            description:
              "Agent-authored narrative summary for the Agent Context block.",
          }),
        ),
        sessionId: Type.Optional(
          Type.String({ description: "Session id; defaults to the current session." }),
        ),
        sessionKey: Type.Optional(
          Type.String({ description: "Session key; defaults to the current session." }),
        ),
        transcript: Type.Optional(
          Type.Boolean({
            description:
              "true (default) writes the full transcript note; false writes a summary-only note.",
          }),
        ),
        filename: Type.Optional(
          Type.String({
            description:
              "Filename override (tokens {date} {hostname} {title} {sessionId}); '.md' auto-added.",
          }),
        ),
      }),
      async execute(params: any) {
        try {
          const sessionId: string =
            params?.sessionId || toolCtx?.sessionId || "";
          const sessionKey: string | undefined =
            params?.sessionKey || toolCtx?.sessionKey;
          const agentId: string | undefined =
            toolCtx?.agentId || agentIdFromSessionKey(sessionKey);

          const events = await readTranscriptEvents(api, {
            agentId,
            sessionKey,
            sessionId,
          });

          const goal = extractGoal(events);
          const title = goal ? goal.split("\n")[0].slice(0, 60) : sessionId || "session";
          const wantTranscript = params?.transcript !== false;
          const kind: "Transcript" | "Summary" = wantTranscript
            ? "Transcript"
            : "Summary";

          const fullPath = await writeNote(
            cfg,
            events,
            { sessionId, sessionKey, agentId, title },
            kind,
            { summary: params?.summary, transcript: wantTranscript },
            params?.filename,
          );

          return {
            content: [{ type: "text", text: `Exported ${kind} note → ${fullPath}` }],
            details: { path: fullPath, kind },
          };
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          await logToFile(cfg.outputDir, `export_to_obsidian ERROR: ${msg}`);
          return {
            content: [{ type: "text", text: `Export failed: ${msg}` }],
            isError: true,
          };
        }
      },
    }));
  },
});
