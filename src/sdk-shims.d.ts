// Ambient declarations for runtime-only OpenClaw SDK subpaths that ship
// without bundled .d.ts type definitions. Typed loosely on purpose; the
// runtime shapes are validated defensively in index.ts.

declare module "openclaw/plugin-sdk/session-transcript-runtime" {
  export function readSessionTranscriptEvents(params: unknown): Promise<unknown[]>;
  export function readVisibleSessionTranscriptMessageEntries(
    params: unknown,
  ): Promise<unknown[]>;
  export function resolveSessionTranscriptIdentity(params: unknown): Promise<unknown>;
  export function resolveSessionTranscriptTarget(params: unknown): Promise<unknown>;
  export function readLatestAssistantTextByIdentity(params: unknown): Promise<unknown>;
}
