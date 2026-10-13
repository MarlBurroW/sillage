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
  // Le texte seul, tel que le nettoyage le laisse : un `%3` coupé, donc rien de bon.
  assert.equal(authUrlFrom(`${visible}\n${rest}`), null)
  assert.equal(authUrlFrom('rien'), null)
})
