import { strict as assert } from 'node:assert'
import type {
  GraphLayout,
  GraphOutput,
  GraphOutputModule
} from 'nest-graph-inspector'
import {
  LAYOUT_GEOMETRY,
  collapsedModulesFromLayout,
  moduleItemIds,
  resolveIncrementalLayout,
  toGraphLayout,
  type IncrementalLayout
} from './graph-layout-placement.ts'

function fixtureModule(
  providers: string[] = [],
  imports: string[] = [],
  controllers: string[] = []
): GraphOutputModule {
  return {
    imports,
    exports: [],
    providers: providers.map(name => ({ name, dependencies: [] })),
    controllers: controllers.map(name => ({ name, dependencies: [] }))
  }
}

function graph(modules: Record<string, GraphOutputModule>): GraphOutput {
  return {
    version: '3',
    root: Object.keys(modules)[0] ?? 'AppModule',
    modules,
    cycles: { modules: [], providers: [], controllers: [] }
  }
}

type Rect = { x: number, y: number, width: number, height: number }

function moduleRect(resolved: IncrementalLayout, name: string): Rect {
  const module = resolved.modules.get(name)
  assert.ok(module, `${name} should be laid out`)
  return { ...module.position, ...module.size }
}

function itemRect(position: { x: number, y: number }): Rect {
  return {
    ...position,
    width: LAYOUT_GEOMETRY.nodeWidth,
    height: LAYOUT_GEOMETRY.nodeHeight
  }
}

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width
    && b.x < a.x + a.width
    && a.y < b.y + b.height
    && b.y < a.y + a.height
  )
}

function assertNoModuleOverlaps(resolved: IncrementalLayout) {
  const names = [...resolved.modules.keys()]
  for (const [index, left] of names.entries()) {
    for (const right of names.slice(index + 1)) {
      assert.equal(
        intersects(moduleRect(resolved, left), moduleRect(resolved, right)),
        false,
        `${left} and ${right} should not overlap`
      )
    }
  }
}

const userModule = fixtureModule(['UserService'], [], ['UserController'])
const savedLayout: GraphLayout = {
  version: '1',
  modules: {
    AppModule: { position: { x: 0, y: 0 } },
    UserModule: {
      position: { x: 700, y: 50 },
      items: {
        'provider-UserModule-UserService': { x: 20, y: 56 },
        'controller-UserModule-UserController': { x: 272, y: 56 }
      }
    }
  }
}

// Item ids are the viewer's node ids, which are also the layout's item keys.
assert.deepEqual(moduleItemIds('UserModule', userModule), [
  'provider-UserModule-UserService',
  'controller-UserModule-UserController'
])

// A pure saved layout: every module and item lands exactly where the file says.
{
  const resolved = resolveIncrementalLayout({
    moduleMap: graph({
      AppModule: fixtureModule([], ['UserModule']),
      UserModule: userModule
    }),
    layout: savedLayout,
    collapsedModules: new Set()
  })

  assert.deepEqual(resolved.newModules, [])
  assert.deepEqual(resolved.newItems, [])
  assert.deepEqual(resolved.modules.get('AppModule')?.position, { x: 0, y: 0 })
  assert.deepEqual(resolved.modules.get('UserModule')?.position, {
    x: 700,
    y: 50
  })
  assert.deepEqual(
    Object.fromEntries(resolved.modules.get('UserModule')!.items),
    savedLayout.modules.UserModule!.items
  )
  // Nothing was added, so saving it back changes nothing.
  assert.deepEqual(toGraphLayout(resolved), savedLayout)
}

// A module added since the layout was saved: everything saved stays put, and
// the newcomer goes beside the module it imports, clear of everything else.
{
  const resolved = resolveIncrementalLayout({
    moduleMap: graph({
      AppModule: fixtureModule([], ['UserModule', 'OrderModule']),
      UserModule: userModule,
      OrderModule: fixtureModule(['OrderService'], ['UserModule'])
    }),
    layout: savedLayout,
    collapsedModules: new Set()
  })

  assert.deepEqual(resolved.newModules, ['OrderModule'])
  assert.deepEqual(resolved.newItems, ['provider-OrderModule-OrderService'])
  assert.deepEqual(resolved.modules.get('AppModule')?.position, { x: 0, y: 0 })
  assert.deepEqual(resolved.modules.get('UserModule')?.position, {
    x: 700,
    y: 50
  })
  assert.equal(resolved.modules.get('OrderModule')?.isSaved, false)

  const user = moduleRect(resolved, 'UserModule')
  assert.deepEqual(resolved.modules.get('OrderModule')?.position, {
    x: user.x + user.width + LAYOUT_GEOMETRY.moduleGapX,
    y: user.y
  })
  assertNoModuleOverlaps(resolved)
}

// A newcomer whose neighbour is boxed in still finds free space, and still
// displaces nothing that was saved.
{
  const crowded: GraphLayout = {
    version: '1',
    modules: {
      Hub: { position: { x: 0, y: 0 } },
      East: { position: { x: 560, y: 0 } },
      South: { position: { x: 0, y: 140 } },
      West: { position: { x: -560, y: 0 } },
      North: { position: { x: 0, y: -140 } }
    }
  }
  const resolved = resolveIncrementalLayout({
    moduleMap: graph({
      Hub: fixtureModule(),
      East: fixtureModule(),
      South: fixtureModule(),
      West: fixtureModule(),
      North: fixtureModule(),
      Spoke: fixtureModule([], ['Hub'])
    }),
    layout: crowded,
    collapsedModules: new Set()
  })

  for (const [name, saved] of Object.entries(crowded.modules)) {
    assert.deepEqual(resolved.modules.get(name)?.position, saved.position)
  }
  assertNoModuleOverlaps(resolved)
}

// With nothing saved at all, every module is placed and none overlaps.
{
  const modules: Record<string, GraphOutputModule> = {
    AppModule: fixtureModule([], ['A', 'B', 'C'])
  }
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
    modules[name] = fixtureModule([`${name}Service`, `${name}Repository`], ['AppModule'])
  }

  const resolved = resolveIncrementalLayout({
    moduleMap: graph(modules),
    layout: null,
    collapsedModules: new Set()
  })

  assert.equal(resolved.newModules.length, Object.keys(modules).length)
  assertNoModuleOverlaps(resolved)
}

// A provider added to a saved module: saved items stay, the newcomer takes the
// first free slot, and the module grows to hold it.
{
  const resolved = resolveIncrementalLayout({
    moduleMap: graph({
      AppModule: fixtureModule([], ['UserModule']),
      UserModule: fixtureModule(
        ['UserService', 'UserRepository'],
        [],
        ['UserController']
      )
    }),
    layout: savedLayout,
    collapsedModules: new Set()
  })
  const user = resolved.modules.get('UserModule')!
  const added = user.items.get('provider-UserModule-UserRepository')

  assert.deepEqual(resolved.newModules, [])
  assert.deepEqual(resolved.newItems, ['provider-UserModule-UserRepository'])
  assert.deepEqual(user.position, { x: 700, y: 50 })
  assert.deepEqual(user.items.get('provider-UserModule-UserService'), {
    x: 20,
    y: 56
  })
  assert.deepEqual(user.items.get('controller-UserModule-UserController'), {
    x: 272,
    y: 56
  })
  // The saved row is full, so the newcomer starts the next one.
  assert.deepEqual(added, {
    x: LAYOUT_GEOMETRY.modulePadding,
    y: 56 + LAYOUT_GEOMETRY.nodeHeight + LAYOUT_GEOMETRY.nodeGapY
  })

  for (const [id, position] of user.items) {
    if (id !== 'provider-UserModule-UserRepository') {
      assert.equal(intersects(itemRect(added!), itemRect(position)), false)
    }
  }
  assert.ok(
    user.size.height
    >= added!.y + LAYOUT_GEOMETRY.nodeHeight + LAYOUT_GEOMETRY.modulePadding
  )
  assert.ok(
    user.size.width
    >= added!.x + LAYOUT_GEOMETRY.nodeWidth + LAYOUT_GEOMETRY.modulePadding
  )
}

// A gap in a saved row is filled before the module is made bigger.
{
  const resolved = resolveIncrementalLayout({
    moduleMap: graph({
      UserModule: fixtureModule(['A', 'B', 'C'])
    }),
    layout: {
      version: '1',
      modules: {
        UserModule: {
          position: { x: 0, y: 0 },
          items: {
            'provider-UserModule-A': { x: 20, y: 56 },
            'provider-UserModule-C': { x: 524, y: 56 }
          }
        }
      }
    },
    collapsedModules: new Set()
  })

  assert.deepEqual(
    resolved.modules.get('UserModule')?.items.get('provider-UserModule-B'),
    { x: 272, y: 56 }
  )
}

// Items dragged anywhere in a module still keep a newcomer from landing on them.
{
  const resolved = resolveIncrementalLayout({
    moduleMap: graph({ UserModule: fixtureModule(['Moved', 'New']) }),
    layout: {
      version: '1',
      modules: {
        UserModule: {
          position: { x: 0, y: 0 },
          items: { 'provider-UserModule-Moved': { x: 30, y: 70 } }
        }
      }
    },
    collapsedModules: new Set()
  })
  const items = resolved.modules.get('UserModule')!.items

  assert.deepEqual(items.get('provider-UserModule-Moved'), { x: 30, y: 70 })
  assert.equal(
    intersects(
      itemRect(items.get('provider-UserModule-New')!),
      itemRect(items.get('provider-UserModule-Moved')!)
    ),
    false
  )
}

// Saved entries for modules and items the graph no longer has are dropped,
// rather than drawn or left occupying space.
{
  const resolved = resolveIncrementalLayout({
    moduleMap: graph({ UserModule: fixtureModule(['UserService']) }),
    layout: {
      version: '1',
      modules: {
        RemovedModule: { position: { x: 0, y: 0 } },
        UserModule: {
          position: { x: 10, y: 10 },
          items: {
            'provider-UserModule-UserService': { x: 20, y: 56 },
            'provider-UserModule-Removed': { x: 272, y: 56 }
          }
        }
      }
    },
    collapsedModules: new Set()
  })

  assert.deepEqual([...resolved.modules.keys()], ['UserModule'])
  assert.deepEqual(
    [...resolved.modules.get('UserModule')!.items.keys()],
    ['provider-UserModule-UserService']
  )
}

// Collapsed state round-trips, and a collapsed module keeps its item positions
// so expanding it again restores them.
{
  const layout: GraphLayout = {
    version: '1',
    modules: {
      UserModule: {
        position: { x: 0, y: 0 },
        isCollapsed: true,
        items: { 'provider-UserModule-UserService': { x: 20, y: 56 } }
      }
    }
  }
  const collapsedModules = collapsedModulesFromLayout(layout)
  const resolved = resolveIncrementalLayout({
    moduleMap: graph({ UserModule: fixtureModule(['UserService']) }),
    layout,
    collapsedModules
  })
  const user = resolved.modules.get('UserModule')!

  assert.deepEqual([...collapsedModules], ['UserModule'])
  assert.equal(user.isCollapsed, true)
  assert.equal(user.size.height, LAYOUT_GEOMETRY.moduleCollapsedHeight)
  assert.deepEqual(toGraphLayout(resolved), layout)
  assert.deepEqual([...collapsedModulesFromLayout(null)], [])
}

// A module none of whose items were saved takes the rows the viewer asks for.
{
  const resolved = resolveIncrementalLayout({
    moduleMap: graph({ UserModule: fixtureModule(['A', 'B', 'C']) }),
    layout: null,
    collapsedModules: new Set(),
    defaultItemRows: () => [['provider-UserModule-C'], ['provider-UserModule-A']]
  })
  const items = resolved.modules.get('UserModule')!.items

  assert.equal(items.get('provider-UserModule-C')?.y, 56)
  assert.equal(items.get('provider-UserModule-A')?.y, 56 + 104)
  // An item the rows left out still gets a place.
  assert.equal(items.get('provider-UserModule-B')?.y, 56 + 208)
}

console.log('graph-layout-placement.test.ts ok')
