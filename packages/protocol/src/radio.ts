/** Claude Code's /radio link; it redirects to the Claude FM live of the moment. */
export const CLAUDE_FM_LINK = 'https://clau.de/radio'

export const MAX_RADIO_URL_CHARS = 500

export interface RadioStationDto {
  videoId: string
  /** Where the station is listened to outside Sillage. */
  link: string
  /** The video's title, or null when YouTube could not be asked. */
  title: string | null
  /** False for Claude FM, the default station. */
  custom: boolean
}

const ID = '([\\w-]{11})'
/**
 * Patterns rather than `new URL`, like git credentials: this package has no URL type in either
 * runtime's typings. Query and fragment are allowed after the ID, never inside the host.
 */
const LINKS = [
  new RegExp(`^https?://(?:www\\.|m\\.|music\\.)?youtube\\.com/watch\\?(?:[^#]*&)?v=${ID}(?:[&#].*)?$`, 'i'),
  new RegExp(`^https?://(?:www\\.|m\\.)?youtube(?:-nocookie)?\\.com/(?:live|embed|shorts)/${ID}(?:[/?#].*)?$`, 'i'),
  new RegExp(`^https?://youtu\\.be/${ID}(?:[/?#].*)?$`, 'i'),
]

/**
 * The video a YouTube link plays: watch, live, embed and shorts pages, and youtu.be short links.
 * Shared by the settings form and the server, so both refuse the same links.
 */
export function youtubeVideoId(link: string): string | null {
  const trimmed = link.trim()
  for (const pattern of LINKS) {
    const id = pattern.exec(trimmed)?.[1]
    if (id) return id
  }
  return null
}
