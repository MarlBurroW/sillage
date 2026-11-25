import { z } from 'zod'

/**
 * Agent browsers (card #112): one headless Chromium per conversation, owned by the daemon. The
 * agent drives it through Playwright MCP connected to a daemon CDP proxy; people watch it live and
 * take over through the daemon's own CDP connection. Optional, behind the `browser` tool family.
 */

/** Pinned like the CLIs: the MCP server's tool names and flags are what agents and Sillage rely on. */
export const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp'
export const PLAYWRIGHT_MCP_VERSION = '0.0.86'

/**
 * MCP server name the browser tools arrive under. Distinct from a user's own `browser` or
 * `playwright` server, and recognizable in tool names (`mcp__sillage-browser__browser_click`).
 */
export const BROWSER_MCP_SERVER_NAME = 'sillage-browser'

/** Where the browser engine came from, so the settings screen can explain what runs. */
export type BrowserEngineSource = 'config' | 'system' | 'playwright-cache' | 'sillage'

export interface BrowserStatusDto {
  /** The browser tools need both: the MCP server agents call, and an engine to drive. */
  mcp: { installed: boolean; version: string | null }
  engine: { path: string; source: BrowserEngineSource } | null
  /** Ready to hand to sessions: both parts present. */
  ready: boolean
  installing: boolean
  /** Last install step, shown while `installing`. */
  progress: string | null
  /** Last install failure, cleared by the next attempt. */
  error: string | null
}

export interface BrowserTabDto {
  targetId: string
  url: string
  title: string
}

/** A running agent browser, as lists show it. */
export interface BrowserDto {
  conversationId: string
  conversationTitle: string
  projectId: string | null
  startedAt: number
  /** The tab the live view follows by default: the one the agent used last. */
  activeTargetId: string | null
  tabs: BrowserTabDto[]
  /** Agent connections (Playwright MCP) currently attached. */
  agentConnected: boolean
  viewers: number
}

export interface BrowserListDto {
  browsers: BrowserDto[]
}

const modifiers = z.number().int().min(0).max(15).default(0)

/** Viewer → daemon, over `/api/conversations/:id/browser/live`. Coordinates are CSS pixels of the page. */
export const browserClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('watch'), targetId: z.string().min(1).nullable() }),
  z.object({
    t: z.literal('mouse'),
    type: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved']),
    x: z.number(),
    y: z.number(),
    button: z.enum(['none', 'left', 'middle', 'right']).default('left'),
    clickCount: z.number().int().min(0).max(3).default(1),
    modifiers,
  }),
  z.object({ t: z.literal('wheel'), x: z.number(), y: z.number(), deltaX: z.number(), deltaY: z.number(), modifiers }),
  z.object({
    t: z.literal('key'),
    type: z.enum(['keyDown', 'keyUp']),
    key: z.string().max(32),
    code: z.string().max(32),
    /** Printable keys carry their text, so keyDown also inserts the character. */
    text: z.string().max(8).optional(),
    keyCode: z.number().int().min(0).max(255).optional(),
    modifiers,
  }),
  /** Pasted or composed text (IME, phone keyboards), inserted at the caret. */
  z.object({ t: z.literal('text'), text: z.string().max(10_000) }),
  z.object({ t: z.literal('navigate'), url: z.string().min(1).max(4096) }),
  z.object({ t: z.literal('history'), action: z.enum(['back', 'forward', 'reload']) }),
])
export type BrowserClientMessage = z.infer<typeof browserClientMessageSchema>

/** Daemon → viewer. */
export type BrowserServerMessage =
  | { t: 'state'; browser: BrowserDto | null; watching: string | null }
  /** JPEG frame (base64) with the page size it was drawn at, for mapping pointer coordinates. */
  | { t: 'frame'; data: string; width: number; height: number }
  | { t: 'error'; code: string; message: string }
