/**
 * Everything the end-to-end suites have to be told about the demo application,
 * because they cannot learn it from the demo while it runs.
 *
 * The rest — module names, cycles, routes, Direct Run targets, the inspector's
 * endpoints and its access token — is read at run time from what the demo
 * prints as it starts and from the graph it serves. Replacing the demo with
 * another application should mean editing this file, and only this file.
 */
export const DEMO: DemoFacts = {
  /**
   * The port `app.listen()` binds in `src/main.ts`. Nest never prints it, so
   * nothing the running demo says can stand in for it.
   */
  appPort: 8889,

  /**
   * The ports the inspector outputs in `src/app.module.ts` bind: the `viewer`
   * output and the plain `http` output. With `appPort`, these are checked
   * free before the demo is spawned and released after it stops, and the
   * endpoints the demo prints must be on one of them.
   */
  inspectorPorts: [53371, 53372],

  /**
   * What `app.setGlobalPrefix()` puts in front of every route. The graph's
   * route metadata leaves it out, so a route read from the graph is requested
   * from the application's own port with this in front of it.
   */
  routePrefix: '',

  /** The outputs `src/app.module.ts` configures besides the `viewer`. */
  outputs: {
    /** A plain `http` output, which announces its endpoints in the log. */
    http: true,
    /** A `json` output, written relative to the working directory. */
    json: true,
    /** A `markdown` output, written relative to the working directory. */
    markdown: true,
  },
};

type DemoFacts = {
  readonly appPort: number;
  readonly inspectorPorts: readonly number[];
  readonly routePrefix: string;
  readonly outputs: {
    readonly http: boolean;
    readonly json: boolean;
    readonly markdown: boolean;
  };
};

/** Every port the demo binds. */
export const DEMO_PORTS: readonly number[] = [
  DEMO.appPort,
  ...DEMO.inspectorPorts,
];
