// Types for config/origins.js.
//
// The module itself is plain JavaScript on purpose: it is imported by
// Vite configs, by scripts/build-assets.mjs and by the landing-page
// checks, none of which run through tsc. This file is what lets the
// TypeScript side of the fence import it without a `@ts-expect-error`.

export declare const ORIGINS: {
  readonly site: string;
  readonly app: string;
  readonly cdn: string;
  readonly api: string;
};

export declare const WIDGET_MAJOR: string;

export declare const TOKENS: Record<string, string>;

export declare function installSrc(): string;

export declare function substitute(text: string): string;
