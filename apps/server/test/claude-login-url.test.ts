import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authUrlFrom } from '../src/claude-accounts/login.js'

const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=t61Bv2FmUaJn2-RcpzNXJhxRaRKkl4JP5-UDGLcdxx0&code_challenge_method=S256&state=7fjhPo19hor_gxoBxxZafOAK8csufblDrMC9HrrDVoA'

test("l'URL d'autorisation vient de la cible du lien OSC 8, pas du texte coupé à la largeur du terminal", () => {
  // claude setup-token output in 200-column terminals (2.1.296): full URL in the
  // link target, visible text split into separately linked lines.
  const visible = url.slice(0, 200)
  const rest = url.slice(200)
  const raw = `Browser didn't open? Use the url below to sign in (c to copy)\r\n\r\n\x1b]8;id=e80dlg;${url}\x07${visible}\x1b]8;;\x07\r\n\x1b]8;id=e80dlg;${url}\x07${rest}\x1b]8;;\x07\r\n\r\nPaste code here if prompted >`
  assert.equal(authUrlFrom(raw), url)
  // Reopened flows print new URLs; the latest wins.
  const reopened = url.replace(/state=.*$/, 'state=AUTRE_FLUX_0123456789')
  assert.equal(authUrlFrom(`${raw}\r\n\x1b]8;id=x;${reopened}\x07${reopened.slice(0, 200)}\x1b]8;;\x07`), reopened)
  // Plain cleaned text ends with incomplete `%3`, so it is unusable.
  assert.equal(authUrlFrom(`${visible}\n${rest}`), null)
  assert.equal(authUrlFrom('rien'), null)
})

test('le jeton se reconstitue par-dessus les sauts de ligne, et s’arrête à la couleur qui suit', async () => {
  const { plain, tokenFrom } = await import('../src/claude-accounts/login.js')
  const token = 'sk-ant-oat01-' + 'A'.repeat(50) + 'b'.repeat(45)
  // Ink frame: colored token wrapped to box width, followed by gray advice.
  const frame = `Your OAuth token (valid for 365 days):\r\n\x1b[33m${token.slice(0, 70)}\r\n${token.slice(70)}\x1b[39m\r\n\x1b[2mStore this token securely. You won't be able to see it again.\x1b[22m\r\n`
  assert.equal(tokenFrom(plain(frame)), token)
  // First truncated rendering then full rendering: retain the longest.
  assert.equal(tokenFrom(plain(`${token.slice(0, 80)}\x1b[0m\r\n` + frame)), token)
  // Too short to be tokens: truncation, not accounts.
  assert.equal(tokenFrom(plain('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz\x1b[0m rest')), null)
  assert.equal(tokenFrom('rien'), null)
})

test('le motif d’un refus s’arrête où le CLI reprend la main, marque de couleur comprise', async () => {
  const { plain } = await import('../src/claude-accounts/login.js')
  const output = plain('\x1b[31mOAuth error: Request failed with status code 400\x1b[39m \x1b[2mPress Enter to retry.\x1b[22m')
  assert.equal(/OAuth\s*error:\s*(.*?)(?=[\s\x00]*(?:Press\s*Enter|Retrying|$))/i.exec(output)?.[1]?.replace(/\x00/g, ''), 'Request failed with status code 400')
})
