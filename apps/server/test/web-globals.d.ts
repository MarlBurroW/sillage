/**
 * The few browser globals web modules imported by these tests touch, guarded at runtime by
 * `typeof document !== 'undefined'`. Declared here rather than adding the DOM lib, which would let
 * server code use browser APIs unnoticed and changes Node's stream and Blob types.
 */
declare const document: { documentElement: { lang: string } }
