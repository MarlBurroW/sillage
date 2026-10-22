# Typing indicator proposals

Standalone comparison page, without integration into the production conversation.
Six motions: Écho, Onde, Orbite, Encre, Constellation, and Souffle. The user selected
Écho, named “Sillage”, as the default, with all six choices in Appearance.
Integration is prepared in the same worktree, without deployment.

## Visual direction

Using Sillage's colors and font lets animations be judged in context. Tokens are
copied from `apps/web/src/styles/tokens.css` at build time; the values below are
only design reference points:

- Dark plum background `#17121a`, surface `#211b25`, line `#39303e`.
- Light ink `#f5f2f7`, secondary ink `#c2b8c8`, lilac accent `#cb8ddd`.
- Sillage system font: title 48 px, option headings 14 px, captions 11 px.

Motion carries personality; the page stays calm. Six tiles compare alternatives,
and the right-hand preview shows their conversation size. Text is left-aligned.
The description's side marker stays square.

```text
Sillage                                      thème / langue
Une idée prend forme.

Choisir un mouvement                 Dans la conversation
[ Écho      ][ Onde          ]       [ question            ]
[ Orbite    ][ Encre         ]       [ réponse + indicateur]
[ Étoiles   ][ Souffle       ]       [ saisie              ]
rythme / accent / pause              Réflexion / Rédaction
                                    Description du choix
```

On phones, choices precede the conversation, with a link to reach the preview
without searching. No remote images or fonts. The Écho logo uses the reference
paths from `docs/brand/symbol.svg`; its shape is not redrawn.

## Build and serve

From the worktree root, with Node 24:

```sh
node docs/prototypes/typing-indicators/build.mjs
```

Default output: `/var/tmp/sillage-typing-proposals`. A first argument selects a
different directory. French and English translations are extracted from the
application catalogs under `prototype.typing.*`.

The October 22, 2026 preview listens privately on port 7476, exposed through Tailscale:
<http://marldev.tail710c78.ts.net:7476>.

The temporary unit stays active after the session until stopped or the next machine
reboot. It is visible in Sillage's **Services**.

```sh
systemctl --user list-units 'sillage-app-*'
systemctl --user stop sillage-app-typing-proposals
# Also remove exposure if the preview is no longer useful.
sudo tailscale serve --http=7476 off
```

## Verification

```sh
NODE_ENV=development node docs/prototypes/typing-indicators/ui-check.mjs
```

The walkthrough checks all six choices, themes, languages, rhythm, pause, color,
thinking/writing states, keyboard, reduced motion, and widths 1440, 768, 390,
and 320 px. Screenshots in `/var/tmp/sillage-typing-ui`. `TYPING_PROPOSALS_URL`
and `TYPING_PROPOSALS_OUTPUT` override defaults.

`pnpm typecheck`, `pnpm test` (345 tests), and `pnpm lint` also pass.
Server and Desktop use the same static mockup here: no dependency on authentication,
notifications, or server profile. This study changes no behavior in either edition.

## Selected integration

`TypingIndicator` supplies designs to the thread (`TurnActivity`) and settings
(`TypingIndicatorControls`). The `lib/typing-indicator.ts` store keeps the local
choice; `appearance-sync.ts` saves it with other account preferences. An old account
or unknown style defaults to Sillage. Reduced motion keeps a static design,
particularly to prevent Encre from disappearing.

Integration validation: `pnpm test:typing-indicator-ui`, typecheck, lint,
346 tests, and web build. Screenshots in `/var/tmp/sillage-typing-integrated`.
The walkthrough covers reload and a second uncached browser, all three themes,
keyboard, phone, and reduced motion. Server test `appearance.test.ts` checks the
API and database path.

Server and Desktop use the same components and preferences route. No SQL migration;
deploy server and web together because the shared schema must retain the new
`appearance.typingIndicator` field.
