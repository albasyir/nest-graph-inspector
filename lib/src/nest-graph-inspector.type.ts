import { Type } from '@nestjs/common';

export type NestGraphInspectorViewerDirectRunOptions = {
  /**
   * Whether to register Direct Run routes for this viewer output.
   *
   * Defaults to `true`. Set to `false` to serve the graph without exposing
   * provider invocation or runtime-trace history routes. The viewer graph
   * also omits Direct Run metadata, so it cannot advertise those routes.
   */
  enabled?: boolean;

  path?: string;

  /**
   * Whether Direct Run may invoke any callable method it finds on a
   * provider's prototype or instance, rather than only the public methods
   * advertised in that provider's Direct Run metadata.
   *
   * Defaults to `true` — permissive, for local development ergonomics: an
   * authenticated caller can run any method, including ones TypeScript marks
   * `private` or `protected`, since that keyword is erased at compile time
   * and unenforceable at runtime anyway. Set to `false` to enforce the
   * stricter allowlist instead: only methods `SourceMetadataService` can
   * confirm are public on the application's own sources, excluding
   * constructors, Nest lifecycle hooks, and instance-shadowed methods. Turn
   * this off before exposing Direct Run outside a trusted development
   * environment.
   */
  allowUnsafeMethods?: boolean;

  /**
   * Upper bound on a Direct Run request body, in encoded bytes.
   *
   * Defaults to 50 MiB. A request over the limit is refused with `413`
   * before it is parsed as JSON. Set to `0` or a negative number to remove
   * the limit.
   */
  maxBodySizeBytes?: number;
};

export type NestGraphInspectorBruteForceOptions = {
  /**
   * Whether failed token guesses are counted per client address.
   *
   * Defaults to `true`.
   */
  enabled?: boolean;

  /**
   * Invalid tokens a client may send inside one window before being blocked.
   *
   * Defaults to 10. A request with no token at all, or with a genuine token
   * that has expired, is not a guess and is not counted.
   */
  maxFailures?: number;

  /**
   * How long failed guesses accumulate before the count resets, in
   * milliseconds. Defaults to one minute.
   */
  windowMs?: number;

  /**
   * How long a blocked client is refused with `429`, in milliseconds.
   *
   * Defaults to fifteen minutes.
   *
   * Behind a reverse proxy every request arrives with the proxy's address, so
   * all callers share one bucket and a single attacker can lock everyone out
   * for this long. Lower it, or set `enabled: false`, in that topology.
   */
  blockMs?: number;

  /**
   * Upper bound on how many client addresses are tracked at once.
   *
   * Defaults to 1000, so the tracker itself cannot be grown without limit by
   * requests from many addresses.
   */
  maxTrackedClients?: number;
};

export type NestGraphInspectorAccessTokenOptions = {
  /**
   * Whether inspector endpoints require an access token.
   *
   * Defaults to `true`. Turning this off exposes the dependency graph and the
   * direct-run endpoint to anyone who can reach the inspector port.
   */
  enabled?: boolean;

  /**
   * How long an issued token stays valid, in milliseconds.
   *
   * Defaults to three hours. A token issued at 13:00 stops working at 16:00,
   * and the next request mints a replacement.
   */
  ttlMs?: number;

  /**
   * Signing secret for issued tokens.
   *
   * Defaults to the `NEST_GRAPH_INSPECTOR_TOKEN_SECRET` environment variable,
   * and falls back to a random per-process secret. Set it when tokens must
   * survive an application restart.
   *
   * Keep it at least 32 characters. A short secret can be recovered offline
   * from a single leaked token, because a token exposes both the payload it
   * signs and the signature itself.
   */
  secret?: string;

  /**
   * Whether the issued token is printed on startup. Defaults to `true`.
   *
   * The startup message is the only place a token is handed out, so turning
   * this off means supplying your own `secret` and minting tokens yourself.
   * Do that where application logs are shipped somewhere the token should not
   * reach.
   */
  logToken?: boolean;

  /**
   * Per-client lockout for repeated invalid tokens.
   *
   * Clients are identified by socket address, not by a forwarded header,
   * since a header can be set by the caller.
   */
  bruteForce?: NestGraphInspectorBruteForceOptions;
};

export type NestGraphInspectorOutput =
  | {
      type: 'viewer';
      origin?: string;
      host?: string;
      port?: number;
      path?: string;
      directRun?: NestGraphInspectorViewerDirectRunOptions;
    }
  | { type: 'markdown'; path: string }
  | { type: 'json'; path: string }
  | {
      type: 'http';
      origin?: string;
      host?: string;
      port?: number;
      path?: string;
    };

export interface NestGraphInspectorModuleOptions {
  /**
   * Which "Root" of module that need to be inspect
   */
  rootModule?: Type;

  /**
   * type definition of output
   *
   * - `type: 'markdown'` writes a markdown (.md) dependency graph
   * - `type: 'json'` writes the raw module map as JSON
   * - `type: 'http'` serves the module map from a native HTTP server on the
   *   given host, port, and route path, plus raw JSON and markdown at
   *   `/output.json` and `/output.md` under that path
   * - `type: 'viewer'` installs graph and direct-run endpoints without
   *   scanning the Nest container during bootstrap. A client requests
   *   `GET {path}/output.json` to discover and cache the graph; that endpoint
   *   responds with the existing GraphOutput JSON shape. `GET {path}/output.md`
   *   resolves the same graph if it has not already been requested. If origin
   *   is provided, it prints a direct viewer URL. Otherwise, it prints the
   *   viewer URL and the endpoint path to enter in the viewer.
   */
  outputs?: NestGraphInspectorOutput[];

  /**
   * Access token protection for every endpoint the inspector installs.
   *
   * Inspector endpoints expose the application's internal structure, and the
   * direct-run endpoint invokes live provider methods, so they are gated by a
   * short-lived token by default. The token is embedded in the viewer link
   * printed on startup, and can also be sent as `Authorization: Bearer`, an
   * `x-graph-inspector-token` header, or an `__inspector_token` query
   * parameter.
   */
  accessToken?: NestGraphInspectorAccessTokenOptions;

  /**
   * Provider names that should be hidden from module exports, provider lists,
   * and dependency resolution.
   *
   * Defaults to `['ModuleRef', 'ApplicationConfig']`.
   */
  ignoreProvider?: string[];

  /**
   * Module names that should be hidden from imports and graph output.
   *
   * Defaults to `['InternalCoreModule', 'NestGraphInspectorModule']`.
   */
  ignoreImport?: string[];

  /**
   * Virtual module name used when NestJS core providers are referenced.
   *
   * Defaults to `'NestJSCoreModule'`.
   */
  nestCoreModuleName?: string;

  /**
   * Provider names that should be grouped under the virtual NestJS core module.
   *
   * Defaults to `['ModuleRef', 'ApplicationConfig', 'Reflector', 'REQUEST', 'INQUIRER']`.
   */
  nestCoreProviders?: string[];

  /**
   * Module-wide Direct Run defaults, applied to every `viewer` output that
   * does not set its own `directRun.allowUnsafeMethods` or
   * `directRun.maxBodySizeBytes`. A `viewer` output's own `directRun` still
   * wins where it sets a value.
   */
  directRun?: NestGraphInspectorViewerDirectRunOptions;
}
