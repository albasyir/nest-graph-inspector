# Security Policy

> [!WARNING]
> Do not report security issues through public GitHub issues, discussions, or
> pull requests.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| Latest release on npm | Yes |
| Older releases | No — please upgrade |

Fixes land in a new release rather than being backported.

## Reporting a Vulnerability

Email **aziz@albasyir.net** with:

- what the issue is and which part it affects (`lib`, `demo`, or `site`)
- the `nest-graph-inspector` version, NestJS version, and Node.js version
- steps to reproduce, and the impact you believe it has

You can expect an acknowledgement within a few days. Please give the maintainer
a reasonable window to ship a fix before disclosing publicly.

## Scope note for users of this package

`nest-graph-inspector` is a **development tool**. Its viewer output exposes your
application's module graph, and its Direct Run endpoint can invoke provider
methods in the running app. Treat any enabled inspector endpoint as a privileged
debug surface: bind it to a loopback interface and keep it out of production and
off shared networks. See the
[configuration docs](https://albasyir.github.io/nest-graph-inspector/configuration)
for the options that control this.
