import { readFile, readdir, readlink } from 'node:fs/promises';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const POLL_INTERVAL_MS = 100;

/** The TCP state `/proc/net/tcp` reports for a listening socket. */
const TCP_LISTEN_STATE = '0A';

type ListenAttempt = 'free' | 'in-use' | 'unsupported';

/** One socket of `/proc/net/tcp` or `/proc/net/tcp6`. */
type TcpSocket = {
  readonly localPort: number;
  readonly state: string;
  readonly inode: string;
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

/**
 * Every TCP socket of this machine's network namespace, read from procfs,
 * or `undefined` where there is no procfs to read (anything but Linux).
 */
async function tcpSockets(): Promise<TcpSocket[] | undefined> {
  const sockets: TcpSocket[] = [];
  let tablesRead = 0;

  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;

    try {
      text = await readFile(table, 'utf8');
    } catch {
      continue;
    }

    tablesRead += 1;

    // sl  local_address  rem_address  st  tx:rx  tr:when  retrnsmt  uid  timeout  inode
    for (const line of text.split('\n').slice(1)) {
      const [, localAddress, , state, , , , , , inode] = line
        .trim()
        .split(/\s+/);
      const localPort = localAddress?.split(':').at(-1);

      if (localPort && state && inode) {
        sockets.push({
          localPort: Number.parseInt(localPort, 16),
          state,
          inode,
        });
      }
    }
  }

  return tablesRead > 0 ? sockets : undefined;
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
 * Whether `port` can be bound on the dual-stack wildcard `::`, which conflicts
 * with a listener on any address — IPv4 or IPv6, loopback or not. Binding
 * `0.0.0.0` alone would miss a listener on `::1`, which is where `localhost` —
 * the host the demo's inspector outputs bind — resolves on many machines.
 * Where the host has no IPv6 at all, nothing can listen on `::1` either.
 */
async function bindsOnEveryAddress(port: number): Promise<boolean> {
  const attempt = await tryListen(port, '::');

  if (attempt === 'unsupported') {
    return (await tryListen(port, '0.0.0.0')) === 'free';
  }

  return attempt === 'free';
}

/**
 * The ports in `ports` something listens on, on any address.
 *
 * Read from procfs where there is one, rather than probed by binding. A bind
 * also fails while an outgoing connection holds the port as its local end,
 * and Linux hands ports 32768–60999 to outgoing connections by default — the
 * inspector's among them — so on a busy machine a bind probe now and then
 * reports a port in use that nothing listens on, and that the inspector,
 * binding `localhost` while the connection is on another address, binds
 * without trouble. Elsewhere, the bind probe it is.
 */
export async function busyPorts(ports: readonly number[]): Promise<number[]> {
  const sockets = await tcpSockets();

  if (sockets) {
    const listening = new Set(
      sockets
        .filter((socket) => socket.state === TCP_LISTEN_STATE)
        .map((socket) => socket.localPort),
    );

    return ports.filter((port) => listening.has(port));
  }

  const free = await Promise.all(ports.map(bindsOnEveryAddress));

  return ports.filter((_, index) => !free[index]);
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

/** Whether a TCP connection to `host:port` is accepted within `timeoutMs`. */
export function acceptsConnection({
  host,
  port,
  timeoutMs,
}: {
  host: string;
  port: number;
  timeoutMs: number;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (accepted: boolean) => {
      socket.destroy();
      resolve(accepted);
    };

    socket.setTimeout(timeoutMs, () => settle(false));
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
  const [inodes, sockets] = await Promise.all([
    socketInodesOf(pid),
    tcpSockets(),
  ]);

  if (!inodes || !sockets) {
    return undefined;
  }

  return new Set(
    sockets
      .filter(
        (socket) =>
          socket.state === TCP_LISTEN_STATE && inodes.has(socket.inode),
      )
      .map((socket) => socket.localPort),
  );
}
