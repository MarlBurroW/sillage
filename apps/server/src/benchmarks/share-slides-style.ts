/**
 * Look of the slideshow. A fixed 1920x1080 stage in pixels, scaled to the window by the script:
 * a recording must look the same on every screen, so the theme is forced dark (the shared page's
 * dark tokens) instead of following the viewer's preference. Sizes are chosen for a 1080p video
 * watched on a phone: no text under 22 px, no line under 3 px (hairlines shimmer once compressed),
 * and the bottom-right corner stays clear for the channel watermark players draw there.
 */
export const SLIDES_CSS = `
:root{color-scheme:dark;--bg:#0f0b11;--surface:#1e1820;--raised:#261f28;--sunken:#171218;--ink:#eee8f0;--muted:#b5aab9;--line:#322936;--accent:#cd7be5;--on-accent:#1b1120;--good:#6fcf97;--bad:#f0837c}
*{box-sizing:border-box}[hidden]{display:none!important}
sg-reveal,sg-conceal{display:contents}
html,body{margin:0;background:#000;color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
body{font-size:22px;line-height:1.35;-webkit-user-select:none;user-select:none;overflow-wrap:anywhere}
.js body{overflow:hidden;height:100vh}
a{color:var(--accent)}
.noscript{margin:0;padding:24px 96px;font-size:28px;background:var(--surface)}
.viewport{position:relative}
.js .viewport{position:fixed;inset:0;overflow:hidden;background:#000}
.stage{position:relative;width:1920px;margin:0 auto;background:var(--bg);outline:none}
.js .stage{position:absolute;left:50%;top:50%;height:1080px;overflow:hidden;transform:translate(-50%,-50%) scale(var(--scale,1));transform-origin:50% 50%}
.js.pinned .stage{left:0;top:0;transform:scale(var(--scale,1));transform-origin:0 0}
.slide{position:relative;width:1920px;height:1080px;padding:54px 96px;display:flex;flex-direction:column;overflow:hidden;background:radial-gradient(1100px 640px at 88% -12%,rgba(205,123,229,.16),transparent 62%),var(--bg)}
.js .slide{position:absolute;inset:0;display:none}
.js .slide.current{display:flex;animation:enter .35s ease both}
@keyframes enter{from{opacity:0}to{opacity:1}}
.st{transition:opacity .45s ease,transform .45s ease}
.js .st:not(.on){opacity:0;transform:translateY(18px)}
.js .swap:not(.on){display:none}
.kicker{margin:0 0 28px;font-size:28px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.slide-title{margin:0;font-size:72px;line-height:1.05;font-weight:750;letter-spacing:-.035em;max-width:24ch}
.slide-head{display:flex;align-items:baseline;justify-content:space-between;gap:48px;margin-bottom:40px}
.hint{margin:10px 0 0;font-size:26px;color:var(--muted)}
.letter{display:inline-grid;place-items:center;flex:none;width:64px;height:64px;border-radius:14px;background:var(--accent);color:var(--on-accent);font-weight:800;font-size:38px;line-height:1}
.mark{display:inline-grid;place-items:center;flex:none;color:var(--ink)}
.mark svg{display:block}
.muted{color:var(--muted)}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.brandline{display:flex;align-items:center;gap:14px;font-size:24px;color:var(--muted)}
.brandline svg{color:var(--ink)}

/* Title */
.s-title{justify-content:center}
.s-title .wake{position:absolute;right:-120px;top:120px;opacity:.07;color:var(--accent);pointer-events:none}
.headline{margin:0;font-size:120px;line-height:1.02;font-weight:800;letter-spacing:-.05em;max-width:15ch}
.subtitle{margin:36px 0 0;font-size:40px;line-height:1.3;color:var(--muted);max-width:42ch;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.facts{display:flex;flex-wrap:wrap;row-gap:16px;margin:56px 0 0;padding:0;list-style:none;font-size:36px;font-weight:650}
.facts li{display:flex;align-items:center}
.facts li+li:before{content:"";flex:none;width:12px;height:12px;margin:0 28px;border-radius:50%;background:var(--accent)}
.s-title .brandline{position:absolute;left:96px;bottom:54px}

/* Task */
.summary{margin:0;font-size:48px;line-height:1.35;max-width:50ch;white-space:pre-wrap}
.chips-row{display:flex;flex-wrap:wrap;gap:16px;margin:auto 0 0;padding:0;list-style:none}
.chips-row li{font-size:26px;font-weight:600;padding:10px 22px;border-radius:999px;background:var(--surface);border:3px solid var(--line)}
.prompt-full{flex:1;min-height:0;margin:0 0 28px;padding:36px 44px;overflow:auto;background:var(--sunken);border:3px solid var(--line);border-radius:18px;font-size:24px;line-height:1.55;white-space:pre-wrap;-webkit-user-select:text;user-select:text}

/* Lineup and reveal cards */
.cards{display:grid;gap:24px;margin:0;padding:0;list-style:none;flex:1;min-height:0;align-content:center}
.cards.c1{grid-template-columns:1fr}.cards.c2{grid-template-columns:repeat(2,1fr)}.cards.c3{grid-template-columns:repeat(3,1fr)}.cards.c4{grid-template-columns:repeat(4,1fr)}.cards.c6{grid-template-columns:repeat(6,1fr)}
.card{position:relative;display:flex;flex-direction:column;gap:12px;min-width:0;min-height:300px;padding:24px 26px;border-radius:18px;background:var(--surface);border:3px solid var(--line)}
.card-top{display:flex;align-items:center;gap:16px}
.card .name{margin:0;font-size:38px;line-height:1.1;font-weight:750;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .sub{margin:0;font-size:24px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .price{margin:auto 0 0;font-size:26px;font-weight:650;font-variant-numeric:tabular-nums}
.card .unknown{color:var(--muted);font-weight:500}
.card .qmark{font-size:64px;font-weight:800;color:var(--muted);line-height:1}
.cards.dense .card{min-height:200px;padding:16px 18px;gap:8px}
.cards.few .card{min-height:420px;padding:36px 34px;gap:16px}.cards.few .card .name{font-size:48px}.cards.few .card .sub,.cards.few .card .price{font-size:28px}.cards.few .letter{width:80px;height:80px;font-size:48px;border-radius:16px}.cards.few .qmark{font-size:88px}.cards.dense .card .name{font-size:28px}.cards.dense .card .sub,.cards.dense .card .price{font-size:22px}.cards.dense .letter{width:48px;height:48px;font-size:28px;border-radius:10px}
.legend{margin:24px 0 0;font-size:24px;color:var(--muted)}

/* Productions */
.s-production{padding:54px 96px}
.frame{position:relative;flex:1;min-height:0;border-radius:18px;overflow:hidden;background:var(--sunken);border:3px solid var(--line)}
.frame iframe{position:absolute;left:0;top:0;width:calc(100% / var(--zoom,1));height:calc(100% / var(--zoom,1));transform:scale(var(--zoom,1));transform-origin:0 0;border:0;background:#fff;opacity:0;transition:opacity .45s ease}
.frame iframe.loaded{opacity:1}
.band{flex:none;display:flex;align-items:center;gap:28px;height:138px;margin-top:24px;padding-right:220px}
.no-band .s-production .band{display:none}
.badge{display:flex;flex-direction:column;align-items:center;gap:6px;flex:none}
.badge .letter{width:72px;height:72px;font-size:44px}
.count{font-size:22px;font-weight:650;color:var(--muted);font-variant-numeric:tabular-nums}
.clean .count{visibility:hidden}
.who{min-width:0;flex:1}
.who .name{display:flex;align-items:center;gap:18px;margin:0;font-size:64px;line-height:1.05;font-weight:800;letter-spacing:-.035em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.who .name>span:last-child,.who .name sg-reveal>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis}
.who .line{display:flex;flex-wrap:wrap;align-items:center;gap:8px 18px;margin:8px 0 0;font-size:28px;color:var(--muted)}
.chips{display:flex;gap:44px;flex:none;margin:0;padding:0;list-style:none}
.chip{display:flex;flex-direction:column;gap:4px}
.chip .k{font-size:22px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.chip .v{font-size:52px;line-height:1.05;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.chip .v.pass{color:var(--good)}.chip .v.fail{color:var(--bad)}
.tag{display:inline-flex;align-items:center;gap:8px;font-size:22px;font-weight:750;color:var(--on-accent);background:var(--accent);border-radius:999px;padding:3px 16px}
.status{font-size:24px;font-weight:750;color:var(--bad);border:3px solid currentColor;border-radius:10px;padding:1px 12px}
.gallery{position:absolute;inset:0;display:grid;gap:18px;padding:18px;background:var(--sunken)}
.gallery.g2{grid-template-columns:1fr 1fr}.gallery.g3,.gallery.g4{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
.gallery figure{position:relative;margin:0;min-height:0;display:flex;flex-direction:column;gap:8px}
.gallery img,.gallery video{flex:1;min-height:0;width:100%;height:100%;object-fit:contain;background:#000;border-radius:10px}
.gallery audio{width:100%;margin:auto 0}
.gallery pre{flex:1;min-height:0;margin:0;padding:24px;overflow:auto;background:var(--surface);border-radius:10px;font-size:22px;line-height:1.5;white-space:pre-wrap}
.gallery figcaption{font-size:22px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.message{position:absolute;inset:0;overflow:auto;padding:44px 60px;background:var(--surface);font-size:32px;line-height:1.5;-webkit-user-select:text;user-select:text}
.message>*{max-width:60ch}.message>:first-child{margin-top:0}
.message pre{font-size:24px;background:var(--sunken);padding:20px 24px;border-radius:10px;overflow:auto}
.message code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.85em}
.message table{border-collapse:collapse}.message th,.message td{border-bottom:3px solid var(--line);padding:8px 14px;text-align:left}
.empty{position:absolute;inset:0;display:grid;place-items:center;align-content:center;gap:16px;padding:80px;text-align:center;font-size:36px;color:var(--muted)}
.empty p{margin:0;max-width:40ch}

/* Guess */
.guess{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:center;gap:64px;flex:1;min-height:0}
.letters{display:flex;flex-wrap:wrap;align-content:start;gap:20px;margin:0;padding:0;list-style:none}
.letters .letter{width:128px;height:128px;font-size:72px;border-radius:22px}
.names{display:grid;grid-auto-rows:min-content;gap:20px;margin:0;padding:0;list-style:none;font-size:44px;font-weight:700}
.names li{display:flex;align-items:center;gap:16px}

/* Arena */
.arena{flex:1;min-height:0;display:grid;gap:24px}
.arena.a2{grid-template-columns:1fr 1fr}.arena.a3{grid-template-columns:repeat(3,1fr)}.arena.a4{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
.lane{position:relative;display:flex;flex-direction:column;gap:14px;margin:0;min-width:0;min-height:0}
.lane .frame{flex:1}
.lane>figcaption{display:flex;align-items:center;gap:14px;font-size:36px;font-weight:750;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lane>figcaption .letter{width:52px;height:52px;font-size:30px;border-radius:12px}
.arena.a4 .lane>figcaption{font-size:28px}
.vs{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);z-index:2;display:grid;place-items:center;width:112px;height:112px;border-radius:50%;background:var(--accent);color:var(--on-accent);font-size:44px;font-weight:850;letter-spacing:-.04em;border:6px solid var(--bg)}

/* Scorecard */
.score{width:100%;border-collapse:separate;border-spacing:0;font-size:34px}
.score th,.score td{padding:20px 26px;text-align:left;border-bottom:3px solid var(--line);vertical-align:middle}
.score thead th{font-size:30px;font-weight:750}
.score thead .head{display:flex;align-items:center;gap:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.score thead .letter{width:48px;height:48px;font-size:28px;border-radius:10px}
.score tbody th{font-weight:650;width:30%}
.score tbody th small{display:block;font-size:22px;font-weight:500;color:var(--muted)}
.score td{font-variant-numeric:tabular-nums;font-weight:650;white-space:nowrap}
.score td small{margin-left:12px;font-size:24px;font-weight:500;color:var(--muted)}
.score td.win{color:var(--accent)}
.score td.win:before{content:"▲ ";font-size:.8em}
.verdict{margin:36px 0 0;font-size:44px;font-weight:800;letter-spacing:-.02em}

/* Charts */
.chart-body{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center}
.bars{display:flex;flex-direction:column;gap:18px;margin:0;padding:0;list-style:none}
.bars.few{gap:28px}.bars.few .track{height:56px}.bars.few .name,.bars.few .value{font-size:40px}.bars.few .rank{font-size:40px}
.bar-row{display:grid;grid-template-columns:56px 64px 48px minmax(0,380px) minmax(0,1fr) 230px;align-items:center;gap:18px;min-height:0}
.bar-row .rank{font-size:34px;font-weight:800;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.bar-row .name{font-size:32px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.track{position:relative;height:40px;border-radius:10px;background:var(--sunken);overflow:hidden}
.fill{position:absolute;left:0;top:0;bottom:0;width:var(--w);background:var(--muted);border-radius:10px;transition:width 1s cubic-bezier(.2,.7,.2,1)}
.js .bar-row:not(.on) .fill{width:0}
.bar-row.best .fill{background:var(--accent)}
.bar-row.best .rank,.bar-row.best .value{color:var(--accent)}
.bar-row.out .fill{width:100%;background:repeating-linear-gradient(135deg,var(--line) 0 14px,transparent 14px 28px)}
.bar-row .value{font-size:34px;font-weight:750;font-variant-numeric:tabular-nums;white-space:nowrap}
.bar-row .value.out{font-size:26px;color:var(--bad)}
.bars.dense{gap:8px}.bars.dense .bar-row{grid-template-columns:48px 44px 36px minmax(0,320px) minmax(0,1fr) 190px}.bars.dense .name,.bars.dense .value,.bars.dense .rank{font-size:24px}.bars.dense .track{height:24px}.bars.dense .letter{width:40px;height:40px;font-size:24px;border-radius:8px}
.axis{display:grid;grid-template-columns:56px 64px 48px minmax(0,380px) minmax(0,1fr) 230px;gap:18px;margin-top:14px;font-size:22px;color:var(--muted);font-variant-numeric:tabular-nums}
.axis .ticks{position:relative;grid-column:5;height:28px}
.axis .ticks span{position:absolute;top:0;white-space:nowrap}
.bars.dense+.axis{grid-template-columns:48px 44px 36px minmax(0,320px) minmax(0,1fr) 190px}

/* Ranking */
.ranking{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,7fr) minmax(0,3fr);gap:56px}
.ranking.solo{grid-template-columns:minmax(0,1fr);justify-items:center}.ranking.solo .podium{width:min(100%,1240px)}
.ranking.crowded{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.podium{display:grid;grid-template-columns:repeat(3,1fr);align-items:end;gap:24px}
.place{display:flex;flex-direction:column;gap:12px;min-width:0;padding:28px 26px;border-radius:18px 18px 0 0;background:var(--surface);border-top:8px solid var(--line)}
.place.p1{min-height:600px;border-top-color:var(--accent)}.place.p2{min-height:480px}.place.p3{min-height:380px}
.place .rank{font-size:96px;line-height:1;font-weight:850;letter-spacing:-.05em;color:var(--muted)}
.place.p1 .rank{color:var(--accent)}
.place .name{display:flex;align-items:center;gap:14px;margin:auto 0 0;font-size:38px;line-height:1.1;font-weight:800;letter-spacing:-.025em}
.place .value{margin:0;font-size:34px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--muted)}
/* Beside the podium, lifted above the bottom-right corner: that corner belongs to the channel watermark. */
.rest{display:flex;flex-direction:column;gap:12px;margin:0 0 170px;padding:0;list-style:none;align-self:end;min-height:0;overflow:hidden}
.rest.dense{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:32px;row-gap:10px}
.rest.dense li{grid-template-columns:44px 36px minmax(0,1fr) auto;gap:12px;font-size:24px}
.rest li{display:grid;grid-template-columns:56px 48px minmax(0,1fr) auto;align-items:center;gap:16px;font-size:30px;font-weight:650}
.rest .rank{color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.rest .value{font-variant-numeric:tabular-nums;color:var(--muted)}
.rest .name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Outro */
.s-outro{justify-content:center}
.outro-text{margin:0 0 22px;font-size:34px;line-height:1.4;max-width:52ch}
.versions{margin:12px 0 0;font-size:28px;color:var(--muted)}
.pagelink{display:inline-flex;align-items:center;gap:14px;margin-top:44px;font-size:34px;font-weight:750;color:var(--accent);text-decoration:none;border:4px solid var(--accent);border-radius:14px;padding:14px 28px;align-self:flex-start}
.s-outro .brandline{position:absolute;left:96px;bottom:54px}

/* Controls: outside the stage, never scaled, hidden while recording */
.hud{position:fixed;left:50%;bottom:18px;z-index:10;display:flex;align-items:center;gap:4px;padding:6px 10px;border-radius:999px;background:rgba(23,18,24,.94);border:2px solid var(--line);transform:translateX(-50%);opacity:0;pointer-events:none;transition:opacity .25s ease}
.hud.on{opacity:1;pointer-events:auto}
.clean .hud{display:none}
.hud button,.hud a{display:grid;place-items:center;width:40px;height:40px;border:0;border-radius:50%;background:none;color:var(--ink);cursor:pointer;font:inherit}
.hud button:hover,.hud a:hover{background:var(--raised)}
.hud button[aria-pressed=true]{color:var(--accent)}
.hud .counter{min-width:84px;padding:0 6px;text-align:center;font-size:16px;font-variant-numeric:tabular-nums;color:var(--muted)}
.hud svg{display:block}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.clean :focus-visible{outline:none}
.clean.idle,.clean.idle *{cursor:none!important}
.overlay{position:fixed;inset:0;z-index:20;overflow:auto;padding:48px;background:rgba(10,7,12,.95)}
.overlay h2{margin:0 0 24px;font-size:28px}
.ov-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.ov-item{display:flex;align-items:flex-start;gap:12px;min-height:72px;padding:14px 16px;text-align:left;border:2px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);font:inherit;font-size:18px;cursor:pointer}
.ov-item[aria-current=true]{border-color:var(--accent)}
.ov-n{font-weight:800;color:var(--accent);font-variant-numeric:tabular-nums}
.keys{display:grid;grid-template-columns:auto 1fr;gap:10px 28px;margin:0;font-size:20px}
.keys dt{font-weight:700;white-space:nowrap}.keys dd{margin:0;color:var(--muted)}
kbd{font-family:inherit;padding:1px 8px;border-radius:6px;background:var(--raised);border:2px solid var(--line)}
.blackout{position:fixed;inset:0;z-index:30;background:#000}
.focus-hint{position:fixed;left:50%;top:16px;z-index:15;margin:0;padding:8px 18px;transform:translateX(-50%);border-radius:999px;background:rgba(23,18,24,.94);border:2px solid var(--line);font-size:16px}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{transition:none!important;animation:none!important}}
`
