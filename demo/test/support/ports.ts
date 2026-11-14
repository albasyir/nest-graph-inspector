import { readFile, readdir, readlink } from 'node:fs/promises';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const CONNECT_TIMEOUT_MS = 1_000;
const POLL_INTERVAL_MS = 100;

/** The TCP state `/proc/net/tcp` reports for a listening socket. */
const TCP_LISTEN_STATE = '0A';

type ListenAttempt = 'free' | 'in-use' | 'unsupported';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function tryListen(port: number, host: string): Promise<ListenAttempt> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (error) => {
      const code = errorCode(error);

      if (code === 'EADDRINUSE') {
        resolve('in-use');
      } else if (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL') {
        resolve('unsupported');
      } else {
        reject(error);
      }
    });
    server.listen({ port, host, ipv6Only: false, exclusive: true }, () => {
      server.close(() => resolve('free'));
    });
  });
}

/**
 * Whether nothing listens on `port`, on any address.
 *
 * Probed by binding the dual-stack wildcard `::`, which conflicts with a
 * listener on any address — IPv4 or IPv6, loopback or not. Binding `0.0.0.0`
 * alone would miss a listener on `::1`, which is where `localhost` — the host
 * the demo's inspector outputs bind — resolves on many machines. Where the
 * host has no IPv6 at all, nothing can listen on `::1` either.
 */
export async function isPortFree(port: number): Promise<boolean> {
  const attempt = await tryListen(port, '::');

  if (attempt === 'unsupported') {
    return (await tryListen(port, '0.0.0.0')) === 'free';
  }

  return attempt === 'free';
}

/** The ports in `ports` something listens on. */
export async function busyPorts(ports: readonly number[]): Promise<number[]> {
  const states = await Promise.all(
    ports.map(async (port) => ({ port, free: await isPortFree(port) })),
  );

  return states.filter((state) => !state.free).map((state) => state.port);
}

/**
 * Waits, by polling, until nothing listens on any of `ports`. A process that
 * has just exited releases its listening sockets with it, so this resolves at
 * once unless something else holds them.
 */
export async function waitForPortsFree({
  ports,
  timeoutMs,
}: {
  ports: readonly number[];
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let busy = await busyPorts(ports);

  while (busy.length > 0 && Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);
    busy = await busyPorts(ports);
  }

  if (busy.length > 0) {
    throw new Error(
      busy
        .map((port) => `port ${port} is still in use after ${timeoutMs} ms`)
        .join('; '),
    );
  }
}

/** Whether a TCP connection to `host:port` is accepted. */
export function acceptsConnection({
  host,
  port,
}: {
  host: string;
  port: number;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (accepted: boolean) => {
      socket.destroy();
      resolve(accepted);
    };

    socket.setTimeout(CONNECT_TIMEOUT_MS, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

async function socketInodesOf(pid: number): Promise<Set<string> | undefined> {
  let descriptors: string[];

  try {
    descriptors = await readdir(`/proc/${pid}/fd`);
  } catch {
    return undefined;
  }

  const inodes = new Set<string>();

  await Promise.all(
    descriptors.map(async (descriptor) => {
      try {
        const target = await readlink(`/proc/${pid}/fd/${descriptor}`);
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];

        if (inode) {
          inodes.add(inode);
        }
      } catch {
        // The descriptor closed between listing and reading it.
      }
    }),
  );

  return inodes;
}

/**
 * The TCP ports process `pid` itself listens on, read from procfs, or
 * `undefined` where there is no procfs to read (anything but Linux).
 *
 * This is what tells a port bound by the process this suite spawned apart
 * from the same port bound by anything else on the machine — another checkout
 * running its own demo, say — which a successful connection cannot.
 */
export async function listeningPortsOf(
  pid: number,
): Promise<ReadonlySet<number> | undefined> {
  const inodes = await socketInodesOf(pid);

  if (!inodes) {
    return undefined;
  }

  const ports = new Set<number>();

  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;

    try {
      text = await readFile(table, 'utf8');
    } catch {
      continue;
    }

    // sl  local_address  rem_address  st  tx:rx  tr:when  retrnsmt  uid  timeout  inode
    for (const line of text.split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/);
      const [, localAddress, , state, , , , , , inode] = columns;
      const port = localAddress?.split(':').at(-1);

      if (state === TCP_LISTEN_STATE && inode && inodes.has(inode) && port) {
        ports.add(Number.parseInt(port, 16));
      }
    }
  }

  return ports;
}
