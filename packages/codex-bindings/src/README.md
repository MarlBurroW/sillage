# Bindings du protocole Codex

**Ne pas modifier à la main.** Ce dossier est généré par le binaire Codex installé :

```
pnpm codex:types
```

Il est commité pour deux raisons : builder Sillage ne doit pas exiger que Codex soit
installé, et un changement de protocole doit apparaître dans une revue de diff plutôt
que d'être découvert en production.

`pnpm codex:types:check` régénère dans un dossier temporaire et échoue si le résultat
diffère du commité. C'est ce qui signale une montée de version de Codex à traiter.

Généré avec **codex-cli 0.142.2**. Toute valeur du protocole utilisée ailleurs dans
Sillage (modes d'approbation, sandbox, niveaux d'effort) doit dériver de ces types,
jamais être recopiée à la main.
