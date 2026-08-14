import { execSync } from 'node:child_process';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
const SERVER_PORT = process.env.SILLAGE_PORT ?? '7317';
// Même résolution que apps/server/tsup.config.ts : tag fourni par la CI de
// release, describe git en build local, `dev` hors dépôt.
function resolveVersion() {
    if (process.env.SILLAGE_VERSION)
        return process.env.SILLAGE_VERSION.replace(/^v/, '');
    try {
        return execSync('git describe --tags --always --dirty', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
    }
    catch {
        return 'dev';
    }
}
export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
        VitePWA({
            /*
             * `prompt` et non `autoUpdate`.
             *
             * `autoUpdate` fait bien prendre le contrôle au nouveau service worker, mais la
             * page déjà chargée continue de tourner sur l'ancien code : rien ne la prévient,
             * rien ne la recharge. Sur une PWA installée qui reprend depuis la mémoire au
             * lieu de naviguer, elle restait indéfiniment sur un build périmé, et une
             * correction déployée n'atteignait jamais l'écran.
             *
             * En mode `prompt`, l'application est notifiée et propose le rechargement. Le
             * faire d'autorité perdrait un message en cours de saisie.
             */
            registerType: 'prompt',
            // L'enregistrement se fait depuis l'application, qui a besoin du retour de
            // `useRegisterSW` pour afficher l'invite.
            injectRegister: null,
            // `push-sw.js` doit être copié tel quel : il n'est pas importé par le bundle,
            // c'est le service worker qui le charge à l'exécution.
            includeAssets: ['apple-touch-icon.png', 'favicon.svg', 'push-sw.js'],
            manifest: {
                name: 'Sillage',
                short_name: 'Sillage',
                description: 'Plateforme de développement agentique self-hosted et multi-CLI',
                lang: 'fr',
                start_url: '/',
                scope: '/',
                display: 'standalone',
                orientation: 'portrait-primary',
                background_color: '#0b0d1c',
                theme_color: '#0b0d1c',
                icons: [
                    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
                    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
                    // `maskable` réserve la zone rognée par les masques d'Android : sans cette
                    // entrée, l'icône est recadrée dans le cercle et le motif disparaît.
                    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                ],
            },
            workbox: {
                // Nos écouteurs push sont chargés dans le service worker généré, plutôt que
                // d'écrire celui-ci entièrement à la main : le précache reste géré par Workbox.
                importScripts: ['/push-sw.js'],
                // La coque applicative est précachée, jamais les réponses d'API : les mettre
                // en cache produirait un fil incohérent avec le journal (invariant I2).
                globPatterns: ['**/*.{js,css,html,woff2}'],
                navigateFallback: '/index.html',
                navigateFallbackDenylist: [/^\/api\//],
                runtimeCaching: [{ urlPattern: /^\/api\//, handler: 'NetworkOnly' }],
                cleanupOutdatedCaches: true,
            },
            devOptions: { enabled: false },
        }),
    ],
    server: {
        port: 5317,
        proxy: {
            '/api': {
                target: `http://127.0.0.1:${SERVER_PORT}`,
                changeOrigin: true,
                ws: true,
            },
        },
    },
    /**
     * Identifiant du build, affiché dans les réglages.
     *
     * Sans lui, « je ne vois pas la correction » ne se tranche pas : rien à l'écran ne
     * dit quelle version tourne réellement.
     */
    define: {
        __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
        __APP_VERSION__: JSON.stringify(resolveVersion()),
    },
    build: {
        outDir: 'dist',
        sourcemap: true,
    },
});
//# sourceMappingURL=vite.config.js.map