export function antigravityArgs(platform: NodeJS.Platform = process.platform): string[] {
  // The Linux distribution uses an embedded Python launcher requiring this flag.
  return platform === 'linux' ? ['--uid='] : []
}
