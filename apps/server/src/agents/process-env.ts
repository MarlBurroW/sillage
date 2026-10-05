/** Le mode du serveur ne doit pas imposer celui des projets travaillés par les agents. */
export function agentProcessEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // En production, npm omet les devDependencies, pourtant nécessaires aux agents.
  delete env.NODE_ENV
  return { ...env, ...overrides }
}
