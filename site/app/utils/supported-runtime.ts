export const Runtime = {
  NodeJS: 'nodejs',
  Bun: 'bun'
} as const

export type Runtime = typeof Runtime[keyof typeof Runtime]

export const NodeJSPackageManager = {
  NPM: 'npm',
  YARN: 'yarn',
  PNPM: 'pnpm'
} as const

export type NodeJSPackageManager = typeof NodeJSPackageManager[keyof typeof NodeJSPackageManager]

export const BunPackageManager = {
  BUN: 'bun'
} as const

export type BunPackageManager = typeof BunPackageManager[keyof typeof BunPackageManager]

export type PackageManager = NodeJSPackageManager | BunPackageManager

export type SupportedRuntime = {
  type: typeof Runtime.NodeJS
  packageManager: readonly NodeJSPackageManager[]
} | {
  type: typeof Runtime.Bun
  packageManager: readonly BunPackageManager[]
}

export const supportedRuntimes = [
  {
    type: Runtime.NodeJS,
    packageManager: [
      NodeJSPackageManager.NPM,
      NodeJSPackageManager.YARN,
      NodeJSPackageManager.PNPM
    ]
  },
  {
    type: Runtime.Bun,
    packageManager: [
      BunPackageManager.BUN
    ]
  }
] as const satisfies readonly SupportedRuntime[]

export const supportedPackageManagers = supportedRuntimes.flatMap(runtime => runtime.packageManager)

export const defaultPackageManager = NodeJSPackageManager.NPM

export const packageManagerCommandSets = {
  'install': {
    [NodeJSPackageManager.NPM]: 'npm install nest-graph-inspector',
    [NodeJSPackageManager.YARN]: 'yarn add nest-graph-inspector',
    [NodeJSPackageManager.PNPM]: 'pnpm add nest-graph-inspector',
    [BunPackageManager.BUN]: 'bun add nest-graph-inspector'
  },
  'force-install': {
    [NodeJSPackageManager.NPM]: 'npm install nest-graph-inspector --force',
    [NodeJSPackageManager.YARN]: 'yarn add nest-graph-inspector --ignore-engines',
    [NodeJSPackageManager.PNPM]: 'pnpm add nest-graph-inspector --force',
    [BunPackageManager.BUN]: 'bun add nest-graph-inspector'
  },
  'start': {
    [NodeJSPackageManager.NPM]: 'npm run start',
    [NodeJSPackageManager.YARN]: 'yarn start',
    [NodeJSPackageManager.PNPM]: 'pnpm start',
    [BunPackageManager.BUN]: 'bun run start'
  }
} as const satisfies Record<string, Record<PackageManager, string>>

export type PackageManagerCommandSet = keyof typeof packageManagerCommandSets

export function isSupportedPackageManager(value: string): value is PackageManager {
  return supportedPackageManagers.some(packageManager => packageManager === value)
}

export function isPackageManagerCommandSet(value: string): value is PackageManagerCommandSet {
  return value in packageManagerCommandSets
}

export function getPackageManagerCommand(
  commandSet: PackageManagerCommandSet,
  packageManager: PackageManager
): string {
  return packageManagerCommandSets[commandSet][packageManager]
}
