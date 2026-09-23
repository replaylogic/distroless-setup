import { MARKER, VERSION } from "../../core/report";
import { InstallAnswers, installLines } from "../../core/npm";
import { RuntimeConfig, renderServeStages } from "../shared/static-spa";
import { Obj, tsKey, tsType } from "./analysis";

export const FILE_PREFIX = "_runtime-config";

export function renderDockerfile(o: {
  nodeImage: string; install: InstallAnswers; build: string; out: string;
  rc: RuntimeConfig; goImage: string; image: string; port: string; serverDir: string;
}): string {
  const L = [
    `# ${MARKER} v${VERSION}. Re-run \`npx distroless-setup angular\` to regenerate.`,
    "",
    "# ---- Stage 1: build the Angular app ----",
    `FROM ${o.nodeImage} AS build`,
    "WORKDIR /app",
    ...installLines(o.install),
    "",
    "COPY . .",
    `RUN ${o.build}`,
  ];
  if (o.rc.enabled && o.rc.override)
    L.push("", "# Environment-specific build-time config", `COPY ${o.rc.override} ${o.out}${o.rc.url}`);
  L.push("", "", ...renderServeStages(o));
  return L.join("\n");
}

export function renderTsModel(config: Obj, url: string): string {
  const body = Object.entries(config).map(([k, v]) => `  ${tsKey(k)}: ${tsType(v)};`).join("\n") || "  // no keys";
  return `// ${MARKER} v${VERSION}. Re-running distroless-setup regenerates this file.
// Shape of the runtime config JSON the app loads before bootstrap.
// To add a key: add it here, to the config JSON files, and re-run distroless-setup
// so the container can also set it from an environment variable.

export interface RuntimeConfig {
${body}
}

/** URL path the config is fetched from (relative to <base href>). */
export const RUNTIME_CONFIG_PATH = ${JSON.stringify(url)};

/** Keys expected in the config JSON; missing ones are reported in the console. */
export const RUNTIME_CONFIG_KEYS = [${Object.keys(config).map((k) => JSON.stringify(k)).join(", ")}] as const satisfies readonly (keyof RuntimeConfig)[];
`;
}

export function renderTsService(): string {
  return `// ${MARKER} v${VERSION}. Re-running distroless-setup regenerates this file.
//
// Loads the runtime config JSON once, before the app bootstraps, and exposes it
// through RuntimeConfigService (DI) or runtimeConfig() (a plain function, usable
// anywhere that runs after bootstrap). Uses fetch() rather than HttpClient so no
// HTTP interceptor can run on, or depend circularly on, the config request.
import { EnvironmentProviders, Injectable, inject, provideAppInitializer } from '@angular/core';

import { RUNTIME_CONFIG_KEYS, RUNTIME_CONFIG_PATH, RuntimeConfig } from './${FILE_PREFIX}.model';

let loaded: Readonly<RuntimeConfig> | null = null;
let pending: Promise<Readonly<RuntimeConfig>> | null = null;

async function fetchConfig(): Promise<Readonly<RuntimeConfig>> {
  const url = new URL(RUNTIME_CONFIG_PATH.replace(/^\\//, ''), document.baseURI);
  const res = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(\`[runtime-config] Could not load \${url.pathname}: HTTP \${res.status}\`);
  }
  const data = (await res.json()) as Partial<RuntimeConfig>;
  const missing = RUNTIME_CONFIG_KEYS.filter((k) => !(k in data));
  if (missing.length) {
    console.warn(\`[runtime-config] \${url.pathname} is missing: \${missing.join(', ')}\`);
  }
  return Object.freeze(data as RuntimeConfig);
}

/**
 * The loaded runtime config. Call it where the value is needed (inside methods,
 * constructors, factories), not at module top level: it throws if called before
 * the config has been loaded.
 */
export function runtimeConfig(): Readonly<RuntimeConfig> {
  if (!loaded) {
    throw new Error(
      '[runtime-config] Runtime config read before it was loaded. Move the read into code that runs ' +
        'after bootstrap, await RuntimeConfigService.load() first, or call ' +
        'setRuntimeConfigForTesting() in unit tests.',
    );
  }
  return loaded;
}

@Injectable({ providedIn: 'root' })
export class RuntimeConfigService {
  /** Loads the config once. Other initializers can safely \`await\` this too. */
  load(): Promise<Readonly<RuntimeConfig>> {
    if (loaded) {
      return Promise.resolve(loaded);
    }
    pending ??= fetchConfig().then(
      (cfg) => (loaded = cfg),
      (err) => {
        pending = null;
        throw err;
      },
    );
    return pending;
  }

  /** The whole config (throws if not loaded yet). */
  get config(): Readonly<RuntimeConfig> {
    return runtimeConfig();
  }

  /** One config value (throws if not loaded yet). */
  get<K extends keyof RuntimeConfig>(key: K): RuntimeConfig[K] {
    return runtimeConfig()[key];
  }
}

/** Add to your application providers (app.config.ts). */
export function provideRuntimeConfig(): EnvironmentProviders {
  return provideAppInitializer(() => inject(RuntimeConfigService).load());
}

/** Unit tests: set (or clear with null) the config without fetching it. */
export function setRuntimeConfigForTesting(config: Partial<RuntimeConfig> | null): void {
  loaded = config ? Object.freeze({ ...config } as RuntimeConfig) : null;
  pending = null;
}
`;
}
