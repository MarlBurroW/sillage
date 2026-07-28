/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

/** Injecté à la compilation par `define` : dit quelle version tourne réellement. */
declare const __BUILD_TIME__: string
/** Version de release (tag git), `dev` hors build de release. */
declare const __APP_VERSION__: string
