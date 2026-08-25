/// <reference types="vite/client" />

// Declared explicitly rather than relying on ImportMetaEnv's index
// signature: that yields `any`, which would quietly widen the exported
// constants in lib/config.ts to `any` as well.
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_WIDGET_SRC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Substituted at build time by Vite `define`, from config/origins.js —
// the only place in the repo a hostname is written. Declared as consts
// rather than on a namespace so a typo is a compile error here rather
// than an `undefined` in the bundle.
declare const __CK_API__: string;
declare const __CK_CDN__: string;
declare const __CK_SITE__: string;
declare const __CK_WIDGET_SRC__: string;
