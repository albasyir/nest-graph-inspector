/**
 * Installs the raw-NestJS spike's packages into a headless pod once, here, and
 * writes the resulting volume to `public/` as a gzipped snapshot, so the
 * `/raw-spike` page and `verify-raw-nestjs-spike.ts` restore `node_modules` in
 * one step instead of resolving and downloading ~100 packages from npm on
 * every run.
 *
 * `restore` replaces a pod's whole volume, so the snapshot keeps the base
 * filesystem the pod booted with and prunes only inside `node_modules`, and
 * only files nothing executes: type declarations, source maps, prose, and
 * tests. Licence files stay — the snapshot redistributes these packages from
 * a public site, and their licences require the notice to travel with them.
 *
 * Volatile metadata (inodes, timestamps, owners) is dropped, so building twice
 * from the same versions writes the same bytes.
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

/** Directories whose whole subtree is test or fixture code. */
const PRUNED_DIRECTORIES = new Set(['test', 'tests', '__tests__', '__mocks__'])

/** File names nothing `require`s at runtime. */
const PRUNED_FILES = [
  /\.d\.[cm]?ts$/,
  /\.map$/,
  /\.(md|markdown|txt)$/i,
  /^(changelog|history|changes)(\..*)?$/i,
  /\.(test|spec)\.[cm]?[jt]s$/
]

/** Is this entry inside a package and of no use to a running program? */
function isPrunable(path: string) {
  // The innermost package, so a nested `node_modules` is judged on its own.
  const index = path.lastIndexOf('/node_modules/')

  if (index === -1) {
    return false
  }

  const segments = path.slice(index + '/node_modules/'.length).split('/')
  const name = segments[segments.length - 1]!

  // Skip the package's own name: only directories inside a package are
  // test directories, so a package that is itself called `test` survives.
  const insidePackage = segments.slice(segments[0]!.startsWith('@') ? 2 : 1)

  return insidePackage.some(segment => PRUNED_DIRECTORIES.has(segment))
    || PRUNED_FILES.some(pattern => pattern.test(name))
}

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
  const full = pod.snapshot({ shallow: false })
  const kept = full.entries.filter(entry => !isPrunable(entry.path)).map(stable)
  const prunedBytes = full.entries
    .filter(entry => isPrunable(entry.path))
    .reduce((total, entry) => total + (entry.data?.length ?? 0), 0)

  // Packages install into `/node_modules` at the virtual filesystem root, and
  // Node module resolution from `/app` walks up to `/node_modules` automatically.
  // We avoid a symlink at `/app/node_modules` because Nodepod's worker sandbox
  // VFS throws ENOTDIR when resolving paths through directory symlinks.
  kept.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const snapshot: RawSpikeVendorSnapshot = {
    packages: Object.fromEntries(RAW_SPIKE_PACKAGES),
    entries: kept
  }

  assertRawSpikeVendorSnapshot(snapshot)

  const json = JSON.stringify(snapshot)
  const compressed = gzipSync(json, { level: 9 })

  await mkdir(dirname(OUTPUT_FILE), { recursive: true })
  await writeFile(OUTPUT_FILE, compressed)
  await mkdir(dirname(ASSETS_FILE), { recursive: true })
  await writeFile(ASSETS_FILE, compressed)

  console.log(`wrote ${OUTPUT_FILE} and ${ASSETS_FILE}`)
  console.table({
    'installed packages': installed,
    'entries (kept / total)': `${kept.length.toLocaleString()} / ${full.entries.length.toLocaleString()}`,
    'files kept': kept.filter(entry => entry.kind === 'file').length.toLocaleString(),
    'pruned (base64)': mb(prunedBytes),
    'uncompressed JSON': mb(json.length),
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
