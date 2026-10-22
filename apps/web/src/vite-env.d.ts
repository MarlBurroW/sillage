/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

/** Injected at build time by `define` to identify the actually running version. */
declare const __BUILD_TIME__: string
/** Release version (Git tag), `dev` outside release builds. */
declare const __APP_VERSION__: string
