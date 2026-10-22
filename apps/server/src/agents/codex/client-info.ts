/**
 * Identity supplied at app-server initialize. Keep one definition instead of duplicated callers,
 * which would create inconsistent CLI diagnostics if they diverged.
 */
export const CLIENT_INFO = { name: 'sillage', title: 'Sillage', version: '0.1.0' } as const
