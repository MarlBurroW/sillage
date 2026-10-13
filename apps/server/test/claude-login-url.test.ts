import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authUrlFrom } from '../src/claude-accounts/login.js'

const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=t61Bv2FmUaJn2-RcpzNXJhxRaRKkl4JP5-UDGLcdxx0&code_challenge_method=S256&state=7fjhPo19hor_gxoBxxZafOAK8csufblDrMC9HrrDVoA'

test("l'URL d'autorisation vient de la cible du lien OSC 8, pas du texte coupé à la largeur du terminal", () => {
  // Ce que claude setup-token écrit sous un terminal de 200 colonnes (2.1.296) : le lien
  // entier en cible, puis le texte visible en morceaux d'une ligne, chacun relié.
  const visible = url.slice(0, 200)
  const rest = url.slice(200)
  const raw = `Browser didn't open? Use the url below to sign in (c to copy)\r\n\r\n\x1b]8;id=e80dlg;${url}\x07${visible}\x1b]8;;\x07\r\n\x1b]8;id=e80dlg;${url}\x07${rest}\x1b]8;;\x07\r\n\r\nPaste code here if prompted >`
  assert.equal(authUrlFrom(raw), url)
  // Un flux rouvert imprime une nouvelle URL : c'est la dernière qui compte.
  const reopened = url.replace(/state=.*$/, 'state=AUTRE_FLUX_0123456789')
  assert.equal(authUrlFrom(`${raw}\r\n\x1b]8;id=x;${reopened}\x07${reopened.slice(0, 200)}\x1b]8;;\x07`), reopened)
  // Le texte seul, tel que le nettoyage le laisse : un `%3` coupé, donc rien de bon.
  assert.equal(authUrlFrom(`${visible}\n${rest}`), null)
  assert.equal(authUrlFrom('rien'), null)
})

test('le jeton se reconstitue par-dessus les sauts de ligne, et s’arrête à la couleur qui suit', async () => {
  const { plain, tokenFrom } = await import('../src/claude-accounts/login.js')
  const token = 'sk-ant-oat01-' + 'A'.repeat(50) + 'b'.repeat(45)
  // Le cadre Ink : le jeton en couleur, coupé à la largeur de la boîte, puis le conseil en gris.
  const frame = `Your OAuth token (valid for 365 days):\r\n\x1b[33m${token.slice(0, 70)}\r\n${token.slice(70)}\x1b[39m\r\n\x1b[2mStore this token securely. You won't be able to see it again.\x1b[22m\r\n`
  assert.equal(tokenFrom(plain(frame)), token)
  // Une première image coupée, puis l'entière : la plus longue l'emporte.
  assert.equal(tokenFrom(plain(`${token.slice(0, 80)}\x1b[0m\r\n` + frame)), token)
  // Trop court pour être un jeton : une coupure, pas un compte.
  assert.equal(tokenFrom(plain('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz\x1b[0m rest')), null)
  assert.equal(tokenFrom('rien'), null)
})

test('le motif d’un refus s’arrête où le CLI reprend la main, marque de couleur comprise', async () => {
  const { plain } = await import('../src/claude-accounts/login.js')
  const output = plain('\x1b[31mOAuth error: Request failed with status code 400\x1b[39m \x1b[2mPress Enter to retry.\x1b[22m')
  assert.equal(/OAuth\s*error:\s*(.*?)(?=[\s\x00]*(?:Press\s*Enter|Retrying|$))/i.exec(output)?.[1]?.replace(/\x00/g, ''), 'Request failed with status code 400')
})
