/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL of a splat to load by default (set for private builds that bundle one). */
  readonly VITE_SPLAT_URL?: string;
}
