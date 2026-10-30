/**
 * Installs the raw-NestJS spike's packages into a headless pod once, here, and
 * writes the resulting volume as a gzipped snapshot — to `assets/nodepod-demo/`,
 * the committed copy the demo payload ships to the browser, and to `public/`
 * for `verify-raw-nestjs-spike.ts` — so a pod restores `node_modules` in one
 * step instead of resolving and downloading ~100 packages from npm on every
 * run.
 *
 * The snapshot is the unfiltered install: every entry the pod's volume holds
 * goes in, with the source maps, type definitions, docs, licences, and tests a
 * production `node_modules` has. When the application fails inside the pod,
 * the source maps and type definitions are what trace the error back to its
 * cause, and a larger download is the accepted cost of having them there.
 *
 * Volatile metadata (inodes, timestamps, owners) is dropped. A rebuild is
 * still not reproducible: transitive dependencies resolve to whatever the
 * registry serves at the time, two runs can hoist the same packages into a
 * different layout, and the lockfiles the install writes list packages in
 * resolution order, which varies from run to run too.
 *
 * Needs network access to the npm registry. Run it again whenever
 * `RAW_SPIKE_PACKAGES` changes; the loader refuses a snapshot built from other
 * versions.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { Nodepod } from '@scelar/nodepod/headless'
import type { Snapshot } from '@scelar/nodepod/headless'
import {
  RAW_SPIKE_PACKAGES,
  RAW_SPIKE_SNAPSHOT_PATH,
  RAW_SPIKE_WORKDIR,
  assertRawSpikeVendorSnapshot
} from '../app/utils/raw-nestjs-spike.ts'
import type { RawSpikeVendorSnapshot } from '../app/utils/raw-nestjs-spike.ts'

type Entry = Snapshot['entries'][number]

const OUTPUT_FILE = fileURLToPath(new URL(`../public${RAW_SPIKE_SNAPSHOT_PATH}`, import.meta.url))
const ASSETS_FILE = fileURLToPath(new URL('../assets/nodepod-demo/vendor-snapshot.json.gz', import.meta.url))

/** Keeps only what `restore` reads, and nothing that changes between builds. */
function stable({ path, kind, data, target, mode, symlinkType }: Entry): Entry {
  return {
    path,
    kind,
    ...(data ? { data } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(symlinkType !== undefined ? { symlinkType } : {})
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`

const startedAt = performance.now()
const pod = await Nodepod.boot({ workdir: RAW_SPIKE_WORKDIR })

try {
  for (const [name, version] of RAW_SPIKE_PACKAGES) {
    console.log(`installing ${name}@${version}`)
    await pod.packages.install(name, version)
  }

  const installed = Object.keys(pod.packages.listInstalled()).length
  const entries = pod.snapshot({ shallow: false }).entries.map(stable)

  // Packages install into `/node_modules` at the virtual filesystem root, and
  // Node module resolution from `/app` walks up to `/node_modules` automatically.
  // We avoid a symlink at `/app/node_modules` because Nodepod's worker sandbox
  // VFS throws ENOTDIR when resolving paths through directory symlinks.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const snapshot: RawSpikeVendorSnapshot = {
    packages: Object.fromEntries(RAW_SPIKE_PACKAGES),
    entries
  }

  assertRawSpikeVendorSnapshot(snapshot)

  const json = JSON.stringify(snapshot)
  const compressed = gzipSync(json)

  await mkdir(dirname(OUTPUT_FILE), { recursive: true })
  await writeFile(OUTPUT_FILE, compressed)
  await mkdir(dirname(ASSETS_FILE), { recursive: true })
  await writeFile(ASSETS_FILE, compressed)

  console.log(`wrote ${OUTPUT_FILE} and ${ASSETS_FILE}`)
  console.table({
    'installed packages': installed,
    'entries': entries.length.toLocaleString(),
    'files': entries.filter(entry => entry.kind === 'file').length.toLocaleString(),
    'uncompressed JSON': mb(Buffer.byteLength(json)),
    'gzip': mb(compressed.byteLength),
    'build time': `${((performance.now() - startedAt) / 1000).toFixed(1)} s`
  })
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
} finally {
  pod.teardown()
}

process.exit(process.exitCode ?? 0)
