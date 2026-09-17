# openclaw-obsidian-export

Persistent memory for **every** OpenClaw session, saved straight into your Obsidian vault — the OpenClaw port of [`aditrachman/Opencode-Obsidian-Export`](https://github.com/aditrachman/Opencode-Obsidian-Export).

Every agent's session is automatically dumped to a single shared folder as a Markdown note. No LLM calls, no tokens — it just reads the local session transcript and writes a file. An optional on-demand command exports an agent-authored **summary** when you explicitly ask for one.

## What it does

- **Automatic transcript (zero tokens).** On every `session_end` (idle, daily rollover, `/new`, `/reset`, shutdown, …) the plugin reads the raw session transcript from the local store and writes a Markdown note. Pure local data dump — it never calls a model.
- **On-demand summary (only when you ask).** The `export_to_obsidian` tool lets the *currently running* agent write a narrative summary and save it. The summary is authored by the agent already in the loop and passed as an argument, so there is **no hidden/extra model call** — tokens are spent only when you explicitly request the export.
- **One shared folder for all agents.** Notes from every agent land in the same directory (default `~/Brain/_Shared_Systems/Openclaw/`).
- **No duplicates.** A `.session-index.json` maps each session to its file, so re-exports overwrite in place instead of piling up.

## Note format

Filenames:

- `<hostname> - <session name> - Transcript.md` (automatic)
- `<hostname> - <session name> - Summary.md` (on-demand)

where `hostname` is the short host name and `session name` is the session title (falling back to the session id). Each note has YAML frontmatter (`session_id`, `session_key`, `title`, `agent`, `end_reason`, `exported`, `hostname`, `tags`), an **Agent Context** block (goal, optional summary, highlights, files touched, tools used), and the full transcript with tool calls.

## Install

```sh
openclaw plugins install clawhub:openclaw-obsidian-export
openclaw plugins enable openclaw-obsidian-export
openclaw config set plugins.entries.openclaw-obsidian-export.hooks.allowConversationAccess true
openclaw gateway restart
```

`allowConversationAccess` lets the plugin read session transcripts from the local store.

## Configuration

All optional — set under `plugins.entries.openclaw-obsidian-export.config` in `~/.config/openclaw/openclaw.json`:

| Key | Default | Description |
| --- | --- | --- |
| `outputDir` | `$OBSIDIAN_VAULT_PATH/_Shared_Systems/Openclaw` or `~/Brain/_Shared_Systems/Openclaw` | Directory where notes are written (absolute or `~/`). |
| `userName` | `You` | Label for user messages in the transcript. |
| `assistantName` | `Assistant` | Label for assistant messages. |
| `sessionPrefix` | `Session` | Prefix for the transcript heading. |
| `transcriptFilenameFormat` | `{hostname} - {title} - Transcript` | Auto-transcript filename template. Tokens: `{date}` `{hostname}` `{title}` `{sessionId}`. |
| `summaryFilenameFormat` | `{hostname} - {title} - Summary` | On-demand summary filename template. |

Environment fallbacks: `OBSIDIAN_OPENCLAW_DIR`, then `OBSIDIAN_VAULT_PATH`.

## On-demand summary

Ask the agent to export the current session; it will author a summary and call the tool:

> "Export this session to Obsidian with a summary."

The agent calls `export_to_obsidian` with a `summary` it writes itself (`transcript: false` for a summary-only note, or `true` to also include the full transcript). Because the running agent produces the summary inline, this costs no extra model calls beyond the turn you asked for.

## How it works

- Entry: `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`.
- Auto path: `api.on("session_end", …)` → reads raw events via `readSessionTranscriptEvents` from `openclaw/plugin-sdk/session-transcript-runtime` → renders Markdown (including tool calls) → writes the note. Never uses `console.*` (logs go to `<outputDir>/.plugin.log`).
- On-demand path: `api.registerTool(ctx => …)` — the tool factory receives the session identity (`agentId`, `sessionKey`, `sessionId`) so it can resolve and read the active session's transcript.

## Development

```sh
npm install
npm run build                      # tsc -> dist/index.js
openclaw plugins install --link . --force --accept-capabilities
openclaw plugins enable openclaw-obsidian-export
openclaw gateway restart
openclaw plugins inspect openclaw-obsidian-export --runtime --json
```

## Security & data access

This plugin is **local-only**. It does not make any network calls, phone home, or
send your data anywhere — it only reads the local session store and writes files
into the folder you configure. Be aware of what it does, by design:

- **It stores full session transcripts in plaintext.** Every `session_end`
  writes the complete conversation (user + assistant messages and tool calls)
  as an unencrypted Markdown file. Anything said in a session — including any
  secrets that appear in the transcript — is persisted to disk. Point
  `outputDir` at a vault you control and avoid pasting secrets into sessions.
- **All agents write to one shared folder.** By default every agent's notes go
  to the same directory, so transcripts from different agents live side by side.
  Set a per-use `outputDir` if you need isolation.
- **The `export_to_obsidian` tool can read other sessions.** When you pass an
  explicit `sessionId`/`sessionKey`, the tool reads and exports *that* session's
  transcript (useful for exporting an existing/older session on demand), not
  just the current one. Only sessions in your local store are reachable.
- **Writes and deletes are confined to `outputDir`.** Filenames are reduced to a
  bare basename and path-traversal is stripped; the resolved path is verified to
  stay inside `outputDir` before any file is written or the stale-file dedup
  `unlink` runs, so the plugin cannot touch files outside that directory.
- **Reading transcripts requires your consent.** The plugin only reads the store
  after you set `allowConversationAccess: true`; without it, no transcript is read.

## License

MIT © Rahulsharma0810
