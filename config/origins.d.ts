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

/** The Supabase project the dashboard authenticates against. Switched
 *  by CK_ENV alongside ORIGINS, because a dashboard pointed at one
 *  project while calling an API backed by another is a split brain that
 *  presents as "sign-in works, everything else 401s". */
export declare const SUPABASE: {
  readonly url: string;
  readonly anonKey: string;
};

export declare const WIDGET_MAJOR: string;

export declare const TOKENS: Record<string, string>;

export declare function installSrc(): string;

export declare function substitute(text: string): string;
