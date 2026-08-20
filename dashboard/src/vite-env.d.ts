/// <reference types="vite/client" />

// Declared explicitly rather than relying on ImportMetaEnv's index
// signature: that yields `any`, which would quietly widen the exported
// API/WIDGET_BASE constants in lib/config.ts to `any` as well.
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_WIDGET_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
