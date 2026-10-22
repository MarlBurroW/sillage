/** Server mode must not determine agent project modes. */
export function agentProcessEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // Production npm omits devDependencies needed by agents.
  delete env.NODE_ENV
  return { ...env, ...overrides }
}
