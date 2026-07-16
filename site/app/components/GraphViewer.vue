<script setup lang="ts">
import {
  VueFlow,
  useVueFlow,
  Position,
  Handle,
  MarkerType,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
} from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
import { NodeResizer } from "@vue-flow/node-resizer";
import { useDebounceFn, useResizeObserver } from "@vueuse/core";
import type { CSSProperties } from "vue";
import type { Node, Edge, EdgeProps, NodeMouseEvent } from "@vue-flow/core";
import type * as Monaco from "monaco-editor";
import type {
  GraphOutput,
  GraphOutputModule,
  GraphOutputDependencyRef,
  GraphOutputCycle,
  GraphOutputProviderCycle,
  GraphOutputCycles,
  GraphOutputProvider,
} from "nest-graph-inspector";
import type { CircularDependencyIssue } from "~/utils/circular-dependency-issues";
import { buildCircularIssueFlow } from "~/utils/circular-dependency-flow";
import { resolveCircularDependencyEndpoints } from "~/utils/circular-dependency-issues";
import {
  getDirectRunProviderState,
  parseProviderNodeId,
  type DirectRunExecutionSnapshot,
  type DirectRunProviderMethod,
  type DirectRunResultPayload,
  buildDirectRunRequest,
  buildDirectRunSnapshot,
} from "~/utils/direct-run-provider";

function normalizeDep(dep: GraphOutputDependencyRef): {
  moduleName: string;
  token: string;
} {
  return { moduleName: dep.providedBy.name, token: dep.token };
}

type ModuleNodeData = {
  label: string;
  isRoot: boolean;
  isCollapsed: boolean;
  isExpandable: boolean;
  minWidth: number;
  minHeight: number;
};

type ItemNodeData = {
  label: string;
  kind: "controller" | "provider";
  isExported: boolean;
};

type DirectRunActionRequest = {
  moduleName: string;
  providerName: string;
  methodName: string;
  args?: unknown[];
};

type DirectRunMode = "run" | "inspect";

type DirectRunProviderContext = {
  nodeId: string;
  moduleName: string;
  provider: GraphOutputProvider;
};

type DirectRunStatusBadge = {
  label: string;
  color: "neutral" | "primary" | "success" | "error";
  variant: "soft" | "solid" | "outline";
};

type DirectRunMethodTab = {
  label: string;
  value: string;
  method: DirectRunProviderMethod;
  badge?: string;
};

type DirectRunArgsJsonSchema = Monaco.json.JSONSchema;
type DirectRunEditorMarker = Monaco.editor.IMarker;
type DirectRunParameterInfo = {
  name: string;
  type: string;
  schema: DirectRunArgsJsonSchema;
};
type DirectRunArgsSchemaCacheEntry = {
  fingerprint: string;
  schema: DirectRunArgsJsonSchema;
};

type ModuleItemLayout = ItemNodeData & {
  id: string;
  depth: number;
  dependencies: GraphOutputDependencyRef[];
};

type ModuleItemDependencyGraph = {
  items: ModuleItemLayout[];
  sameModuleDependencies: Map<string, string[]>;
  components: string[][];
  componentByItemId: Map<string, number>;
};

type CircularEdgeInfo = CircularDependencyIssue;

type CircularEdgeData = {
  isNormallyVisible: boolean;
  circularIds: number[];
  circularReason: string;
  circularDetails: CircularEdgeInfo[];
};

type StandardEdgeData = {
  isNormallyVisible: boolean;
};

type FlowEdgeData = CircularEdgeData | StandardEdgeData;

type CircularEdgeDialogData = {
  circularIds: number[];
  issues: CircularEdgeInfo[];
};

type CircularEdgePairAggregate = {
  edgeKeys: string[];
  infoById: Map<number, CircularEdgeInfo>;
  sizeByEdgeKey: Map<string, number>;
};

type FlowNode =
  | Node<ModuleNodeData, Record<string, never>, "module">
  | Node<ItemNodeData, Record<string, never>, "item">;
type FlowEdge = Edge<
  FlowEdgeData,
  Record<string, never>,
  "smoothstep" | "warning"
>;
type WarningEdgeProps = EdgeProps<CircularEdgeData>;
type NodePosition = { x: number; y: number };

const props = withDefaults(
  defineProps<{
    data: GraphOutput;
    height?: string;
    interactive?: boolean;
    flush?: boolean;
    flowId?: string;
    defaultOpenModuleDetail?: boolean;
    fixBightline?: boolean | string;
    excludeModules?: string[] | string;
    enableBrightLine?: boolean;
    collapsedModules?: string[] | string;
    directRunUrl?: string;
    directRunDisabled?: boolean;
    directRunOn?: string;
    showControls?: boolean;
    showMiniMap?: boolean;
  }>(),
  {
    height: "75vh",
    interactive: true,
    flush: false,
    flowId: undefined,
    directRunUrl: undefined,
    directRunDisabled: false,
    directRunOn: undefined,
    showControls: true,
    showMiniMap: true,
    defaultOpenModuleDetail: false,
    fixBightline: false,
    excludeModules: () => [],
    enableBrightLine: true,
    collapsedModules: () => [],
  },
);

const emit = defineEmits<{
  directRunDrawerOpen: [providerName: string];
  directRunDrawerClose: [];
  executionSequenceOpen: [];
}>();

const showCircularDependencies = defineModel<boolean>(
  "showCircularDependencies",
  { default: true },
);

const generatedFlowId = useId();
const flowId = props.flowId || generatedFlowId;
const { fitView } = useVueFlow(flowId);
const graphViewerRef = ref<HTMLElement | null>(null);

const NODE_WIDTH = 200;
const NODE_HEIGHT = 32;
const NODE_GAP_X = 52;
const NODE_LEVEL_GAP_Y = 72;
const MODULE_PADDING = 20;
const MODULE_TITLE_HEIGHT = 36;
const MODULE_COLLAPSED_HEIGHT = 40;
const MODULE_MIN_WIDTH = NODE_WIDTH + MODULE_PADDING * 2;
const MODULE_GAP_X = 320;
const MODULE_GAP_Y = 100;
const GRAPH_FIT_PADDING = 0.12;
const GRAPH_RESIZE_CENTER_DEBOUNCE_MS = 250;
const MODULE_EDGE_COLOR = "#888";
const DEPENDENCY_EDGE_COLOR = "#555";
const CIRCULAR_DEPENDENCY_EDGE_COLOR = "#facc15";
const DEFAULT_FIXED_BRIGHT_LINE_TARGET = "UserRepository";
const BRIGHT_LINE_NODE_CLASS = "bright-line-node";
const BRIGHT_LINE_NODE_ACTIVE_CLASS = "bright-line-node--active";
const BRIGHT_LINE_NODE_CONNECTED_CLASS = "bright-line-node--connected";
const BRIGHT_LINE_NODE_DIMMED_CLASS = "bright-line-node--dimmed";
const BRIGHT_LINE_NODE_FIXED_CLASS = "bright-line-node--fixed";
const BRIGHT_LINE_EDGE_CLASS = "bright-line-edge";
const BRIGHT_LINE_EDGE_DIMMED_CLASS = "bright-line-edge--dimmed";
const BRIGHT_LINE_EDGE_HIDDEN_CLASS = "bright-line-edge--hidden";

function parseModuleNameList(moduleNames: string[] | string): string[] {
  return Array.isArray(moduleNames) ? moduleNames : moduleNames.split(",");
}

function shouldKeepDependency(
  dep: GraphOutputDependencyRef,
  excludedModules: Set<string>,
): boolean {
  return !excludedModules.has(dep.providedBy.name);
}

function filterDependencyCycle(
  cycle: GraphOutputCycle,
  excludedModules: Set<string>,
  moduleNames: Set<string>,
): boolean {
  return cycle.path.every((key) => {
    const parsedKey = splitDependencyCycleKey(key);
    return (
      parsedKey &&
      !excludedModules.has(parsedKey.moduleName) &&
      moduleNames.has(parsedKey.moduleName)
    );
  });
}

function filterGraphOutput(
  moduleMap: GraphOutput,
  excludeModules: string[] | string,
): GraphOutput {
  const moduleNamesToExclude = parseModuleNameList(excludeModules);
  const excludedModules = new Set(
    moduleNamesToExclude.map((moduleName) => moduleName.trim()).filter(Boolean),
  );

  if (excludedModules.size === 0) {
    return moduleMap;
  }

  const modules: GraphOutput["modules"] = {};
  for (const [moduleName, mod] of Object.entries(moduleMap.modules)) {
    if (excludedModules.has(moduleName)) {
      continue;
    }

    modules[moduleName] = {
      ...mod,
      imports: mod.imports.filter(
        (importName) => !excludedModules.has(importName),
      ),
      providers: mod.providers.map((provider) => ({
        ...provider,
        dependencies: provider.dependencies.filter((dep) =>
          shouldKeepDependency(dep, excludedModules),
        ),
      })),
      controllers: mod.controllers.map((controller) => ({
        ...controller,
        dependencies: controller.dependencies.filter((dep) =>
          shouldKeepDependency(dep, excludedModules),
        ),
      })),
    };
  }

  const moduleNames = new Set(Object.keys(modules));
  const root = moduleNames.has(moduleMap.root)
    ? moduleMap.root
    : Object.keys(modules)[0] || moduleMap.root;
  const cycles: GraphOutputCycles = {
    modules: (moduleMap.cycles?.modules || []).filter((cycle) =>
      cycle.path.every(
        (moduleName) =>
          !excludedModules.has(moduleName) && moduleNames.has(moduleName),
      ),
    ),
    providers: (moduleMap.cycles?.providers || []).filter((cycle) =>
      cycle.path.every(
        (item) =>
          !excludedModules.has(item.module.name) &&
          moduleNames.has(item.module.name),
      ),
    ),
    controllers: (moduleMap.cycles?.controllers || []).filter((cycle) =>
      filterDependencyCycle(cycle, excludedModules, moduleNames),
    ),
  };

  return {
    ...moduleMap,
    root,
    modules,
    cycles,
  };
}

const graphData = computed(() =>
  filterGraphOutput(props.data, props.excludeModules),
);

async function centerGraph(duration = 200) {
  if (!import.meta.client) {
    return;
  }

  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await fitView({
    padding: GRAPH_FIT_PADDING,
    duration,
  });
}

const debouncedCenterGraph = useDebounceFn(() => {
  void centerGraph();
}, GRAPH_RESIZE_CENTER_DEBOUNCE_MS);

function assignLayers(moduleMap: GraphOutput): Map<number, string[]> {
  const layers = new Map<number, string[]>();
  const visited = new Set<string>();
  const queue: { name: string; depth: number }[] = [
    { name: moduleMap.root, depth: 0 },
  ];
  visited.add(moduleMap.root);

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      continue;
    }

    const { name, depth } = next;
    let layer = layers.get(depth);
    if (!layer) {
      layer = [];
      layers.set(depth, layer);
    }
    layer.push(name);

    const mod = moduleMap.modules[name];
    if (mod) {
      for (const imp of mod.imports) {
        if (!visited.has(imp) && moduleMap.modules[imp]) {
          visited.add(imp);
          queue.push({ name: imp, depth: depth + 1 });
        }
      }
    }
  }

  for (const name of Object.keys(moduleMap.modules)) {
    if (!visited.has(name)) {
      const maxDepth = Math.max(...Array.from(layers.keys()), 0) + 1;
      let layer = layers.get(maxDepth);
      if (!layer) {
        layer = [];
        layers.set(maxDepth, layer);
      }
      layer.push(name);
    }
  }

  return layers;
}

function getDefaultCollapsedModuleNames(moduleMap: GraphOutput): Set<string> {
  return new Set(Object.keys(moduleMap.modules));
}

function hasModuleComponents(mod: GraphOutputModule): boolean {
  return mod.providers.length > 0 || mod.controllers.length > 0;
}

function getPermanentCollapsedModuleNames(moduleMap: GraphOutput): Set<string> {
  return new Set(
    Object.entries(moduleMap.modules)
      .filter(([, mod]) => !hasModuleComponents(mod))
      .map(([moduleName]) => moduleName),
  );
}

function getInitialCollapsedModuleNames(moduleMap: GraphOutput): Set<string> {
  const collapsedModules = props.defaultOpenModuleDetail
    ? getPermanentCollapsedModuleNames(moduleMap)
    : getDefaultCollapsedModuleNames(moduleMap);

  for (const moduleName of parseModuleNameList(props.collapsedModules)) {
    const normalizedModuleName = moduleName.trim();
    if (normalizedModuleName && moduleMap.modules[normalizedModuleName]) {
      collapsedModules.add(normalizedModuleName);
    }
  }

  return collapsedModules;
}

function resolveDepNodeId(
  dep: GraphOutputDependencyRef,
  currentModule: string,
  moduleMap: GraphOutput,
): string | null {
  const { moduleName, token } = normalizeDep(dep);

  const targetMod = moduleMap.modules[moduleName];
  if (targetMod) {
    if (targetMod.providers.some((provider) => provider.name === token))
      return `provider-${moduleName}-${token}`;
    if (targetMod.controllers.some((controller) => controller.name === token))
      return `controller-${moduleName}-${token}`;
  }

  if (moduleName !== currentModule) {
    return null;
  }

  for (const [modName, modData] of Object.entries(moduleMap.modules)) {
    if (modData.providers.some((provider) => provider.name === token))
      return `provider-${modName}-${token}`;
    if (modData.controllers.some((controller) => controller.name === token))
      return `controller-${modName}-${token}`;
  }

  return null;
}

function isNodeInModule(nodeId: string, moduleName: string): boolean {
  return (
    nodeId.startsWith(`provider-${moduleName}-`) ||
    nodeId.startsWith(`controller-${moduleName}-`)
  );
}

function getModuleItemDependencyGraph(
  moduleName: string,
  mod: GraphOutputModule,
  moduleMap: GraphOutput,
): ModuleItemDependencyGraph {
  const items: ModuleItemLayout[] = [
    ...mod.providers.map((provider) => ({
      id: `provider-${moduleName}-${provider.name}`,
      label: provider.name,
      kind: "provider" as const,
      isExported: mod.exports.includes(provider.name),
      dependencies: provider.dependencies,
      depth: 0,
    })),
    ...mod.controllers.map((controller) => ({
      id: `controller-${moduleName}-${controller.name}`,
      label: controller.name,
      kind: "controller" as const,
      isExported: mod.exports.includes(controller.name),
      dependencies: controller.dependencies,
      depth: 0,
    })),
  ];

  const itemIds = new Set(items.map((item) => item.id));
  const sameModuleDependencies = new Map<string, string[]>();
  for (const item of items) {
    sameModuleDependencies.set(
      item.id,
      item.dependencies
        .map((dep) => resolveDepNodeId(dep, moduleName, moduleMap))
        .filter((nodeId): nodeId is string => typeof nodeId === "string")
        .filter(
          (nodeId) => itemIds.has(nodeId) && isNodeInModule(nodeId, moduleName),
        ),
    );
  }

  const indexById = new Map<string, number>();
  const lowLinkById = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  function visit(itemId: string) {
    indexById.set(itemId, nextIndex);
    lowLinkById.set(itemId, nextIndex);
    nextIndex += 1;
    stack.push(itemId);
    stacked.add(itemId);

    for (const dependencyId of sameModuleDependencies.get(itemId) || []) {
      if (!indexById.has(dependencyId)) {
        visit(dependencyId);
        lowLinkById.set(
          itemId,
          Math.min(
            lowLinkById.get(itemId) || 0,
            lowLinkById.get(dependencyId) || 0,
          ),
        );
      } else if (stacked.has(dependencyId)) {
        lowLinkById.set(
          itemId,
          Math.min(
            lowLinkById.get(itemId) || 0,
            indexById.get(dependencyId) || 0,
          ),
        );
      }
    }

    if (lowLinkById.get(itemId) !== indexById.get(itemId)) {
      return;
    }

    const component: string[] = [];
    let stackedId: string | undefined;
    do {
      stackedId = stack.pop();
      if (stackedId) {
        stacked.delete(stackedId);
        component.push(stackedId);
      }
    } while (stackedId && stackedId !== itemId);
    components.push(component);
  }

  for (const item of items) {
    if (!indexById.has(item.id)) {
      visit(item.id);
    }
  }

  const componentByItemId = new Map<string, number>();
  for (const [componentIndex, component] of components.entries()) {
    for (const itemId of component) {
      componentByItemId.set(itemId, componentIndex);
    }
  }

  return {
    items,
    sameModuleDependencies,
    components,
    componentByItemId,
  };
}

function getModuleItemHierarchy(
  moduleName: string,
  mod: GraphOutputModule,
  moduleMap: GraphOutput,
): ModuleItemLayout[] {
  const { items, sameModuleDependencies, componentByItemId } =
    getModuleItemDependencyGraph(moduleName, mod, moduleMap);

  const kindRank: Record<ItemNodeData["kind"], number> = {
    provider: 0,
    controller: 1,
  };

  const componentDependencies = new Map<number, Set<number>>();
  for (const [itemId, dependencies] of sameModuleDependencies.entries()) {
    const componentIndex = componentByItemId.get(itemId);
    if (componentIndex === undefined) {
      continue;
    }

    const dependenciesSet =
      componentDependencies.get(componentIndex) || new Set<number>();
    for (const dependencyId of dependencies) {
      const dependencyComponentIndex = componentByItemId.get(dependencyId);
      if (
        dependencyComponentIndex !== undefined &&
        dependencyComponentIndex !== componentIndex
      ) {
        dependenciesSet.add(dependencyComponentIndex);
      }
    }
    componentDependencies.set(componentIndex, dependenciesSet);
  }

  const depthByComponent = new Map<number, number>();
  function getComponentDepth(componentIndex: number): number {
    const knownDepth = depthByComponent.get(componentIndex);
    if (knownDepth !== undefined) {
      return knownDepth;
    }

    const dependencies = Array.from(
      componentDependencies.get(componentIndex) || [],
    );
    const depth =
      dependencies.length === 0
        ? 0
        : Math.max(...dependencies.map(getComponentDepth)) + 1;
    depthByComponent.set(componentIndex, depth);
    return depth;
  }

  return items
    .map((item) => {
      const componentIndex = componentByItemId.get(item.id);
      return {
        ...item,
        depth:
          componentIndex === undefined ? 0 : getComponentDepth(componentIndex),
      };
    })
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        kindRank[a.kind] - kindRank[b.kind] ||
        a.label.localeCompare(b.label),
    );
}

function getEdgeDataProps(
  info: CircularEdgeInfo[] | undefined,
  isNormallyVisible: boolean,
): {
  data: FlowEdgeData;
} {
  if (!info?.length) {
    return { data: { isNormallyVisible } };
  }

  const normalizedInfo = Array.from(
    info.reduce<Map<number, CircularEdgeInfo>>((map, item) => {
      map.set(item.id, item);
      return map;
    }, new Map()),
  )
    .map(([, item]) => item)
    .sort((a, b) => a.id - b.id);

  return {
    data: {
      isNormallyVisible,
      circularIds: normalizedInfo.map((item) => item.id),
      circularDetails: normalizedInfo.map((item) => ({
        id: item.id,
        category: item.category,
        type: item.type,
        from: item.from,
        to: item.to,
        path: [...item.path],
      })),
      circularReason: normalizedInfo
        .map((item) => `ID ${item.id}: ${item.path.join(" -> ")}`)
        .join("\n"),
    },
  };
}

function deduplicateCircularEdgeLabels(
  circularEdges: Map<string, CircularEdgeInfo[]>,
): Map<string, CircularEdgeInfo[]> {
  const pairAggregates = new Map<string, CircularEdgePairAggregate>();

  for (const [edgeKey, info] of circularEdges.entries()) {
    const [source, target] = edgeKey.split("->");
    if (!source || !target) {
      continue;
    }

    const pairKey =
      source < target ? `${source}<->${target}` : `${target}<->${source}`;
    let aggregate = pairAggregates.get(pairKey);
    if (!aggregate) {
      aggregate = {
        edgeKeys: [],
        infoById: new Map(),
        sizeByEdgeKey: new Map(),
      };
      pairAggregates.set(pairKey, aggregate);
    }

    aggregate.edgeKeys.push(edgeKey);
    aggregate.sizeByEdgeKey.set(
      edgeKey,
      new Set(info.map((item) => item.id)).size,
    );

    for (const item of info) {
      aggregate.infoById.set(item.id, item);
    }
  }

  const dedupedEdgeLabels = new Map<string, CircularEdgeInfo[]>();

  for (const aggregate of pairAggregates.values()) {
    const mergedInfo = Array.from(aggregate.infoById.values()).sort(
      (a, b) => a.id - b.id,
    );
    if (!aggregate.edgeKeys.length || !mergedInfo.length) {
      continue;
    }

    const [firstEdgeKey] = aggregate.edgeKeys;
    if (!firstEdgeKey) {
      continue;
    }

    let displayEdgeKey = firstEdgeKey;

    for (const edgeKey of aggregate.edgeKeys.slice(1)) {
      const currentSize = aggregate.sizeByEdgeKey.get(displayEdgeKey) || 0;
      const nextSize = aggregate.sizeByEdgeKey.get(edgeKey) || 0;
      if (nextSize > currentSize) {
        displayEdgeKey = edgeKey;
        continue;
      }

      if (nextSize === currentSize && edgeKey < displayEdgeKey) {
        displayEdgeKey = edgeKey;
      }
    }

    dedupedEdgeLabels.set(displayEdgeKey, mergedInfo);
  }

  return dedupedEdgeLabels;
}

function getWarningEdgePath(edgeProps: WarningEdgeProps): string {
  const [path] = getSmoothStepPath({
    sourceX: edgeProps.sourceX,
    sourceY: edgeProps.sourceY,
    sourcePosition: edgeProps.sourcePosition,
    targetX: edgeProps.targetX,
    targetY: edgeProps.targetY,
    targetPosition: edgeProps.targetPosition,
  });

  return path;
}

function getWarningEdgeLabelStyle(edgeProps: WarningEdgeProps): CSSProperties {
  const [, labelX, labelY] = getSmoothStepPath({
    sourceX: edgeProps.sourceX,
    sourceY: edgeProps.sourceY,
    sourcePosition: edgeProps.sourcePosition,
    targetX: edgeProps.targetX,
    targetY: edgeProps.targetY,
    targetPosition: edgeProps.targetPosition,
  });

  return {
    position: "absolute",
    transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
    pointerEvents: "all",
  };
}

function splitDependencyCycleKey(
  key: string,
): { moduleName: string; token: string } | null {
  const separatorIndex = key.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  return {
    moduleName: key.slice(0, separatorIndex),
    token: key.slice(separatorIndex + 1),
  };
}

function formatDependencyCyclePath(path: string[]): string[] {
  return path.map((key) => {
    const parsedKey = splitDependencyCycleKey(key);
    if (!parsedKey) {
      return key;
    }

    return `${parsedKey.token} from ${parsedKey.moduleName}`;
  });
}

function formatProviderCyclePath(
  path: GraphOutputProviderCycle["path"],
): string[] {
  return path.map((item) => `${item.provider.name} from ${item.module.name}`);
}

function resolveCycleNodeId(
  key: string,
  moduleMap: GraphOutput,
  preferredKind?: ItemNodeData["kind"],
): string | null {
  const parsedKey = splitDependencyCycleKey(key);
  if (!parsedKey) {
    return null;
  }

  const mod = moduleMap.modules[parsedKey.moduleName];
  if (!mod) {
    return null;
  }

  if (
    preferredKind === "provider" &&
    mod.providers.some((provider) => provider.name === parsedKey.token)
  ) {
    return `provider-${parsedKey.moduleName}-${parsedKey.token}`;
  }

  if (
    preferredKind === "controller" &&
    mod.controllers.some((controller) => controller.name === parsedKey.token)
  ) {
    return `controller-${parsedKey.moduleName}-${parsedKey.token}`;
  }

  if (mod.providers.some((provider) => provider.name === parsedKey.token)) {
    return `provider-${parsedKey.moduleName}-${parsedKey.token}`;
  }

  if (
    mod.controllers.some((controller) => controller.name === parsedKey.token)
  ) {
    return `controller-${parsedKey.moduleName}-${parsedKey.token}`;
  }

  return null;
}

function resolveCycleDisplayId(
  cycle: Pick<GraphOutputCycle, "id">,
  fallbackId: number,
): number {
  return typeof cycle.id === "number" && Number.isFinite(cycle.id)
    ? cycle.id
    : fallbackId;
}

function addDependencyCycleEdges(
  circularEdges: Map<string, CircularEdgeInfo[]>,
  cycles: GraphOutputCycle[] | undefined,
  moduleMap: GraphOutput,
  fromKind: ItemNodeData["kind"],
): void {
  for (const [cycleIndex, cycle] of (cycles || []).entries()) {
    const displayId = resolveCycleDisplayId(cycle, cycleIndex + 1);
    const formattedPath = formatDependencyCyclePath(cycle.path);
    const { from, to } = resolveCircularDependencyEndpoints(formattedPath);
    const info = {
      id: displayId,
      category: fromKind,
      type: cycle.type,
      from,
      to,
      path: formattedPath,
    };

    addDependencyCyclePathEdges(
      circularEdges,
      cycle.path,
      moduleMap,
      fromKind,
      info,
    );
  }
}

function addProviderDependencyCycleEdges(
  circularEdges: Map<string, CircularEdgeInfo[]>,
  cycles: GraphOutputProviderCycle[] | undefined,
  moduleMap: GraphOutput,
): void {
  for (const [cycleIndex, cycle] of (cycles || []).entries()) {
    const displayId = resolveCycleDisplayId(cycle, cycleIndex + 1);
    const formattedPath = formatProviderCyclePath(cycle.path);
    const { from, to } = resolveCircularDependencyEndpoints(formattedPath);
    const info = {
      id: displayId,
      category: "provider" as const,
      type: cycle.type,
      from,
      to,
      path: formattedPath,
    };

    addDependencyCyclePathEdges(
      circularEdges,
      cycle.path.map(providerCyclePathItemToKey),
      moduleMap,
      "provider",
      info,
    );
  }
}

function addDependencyCyclePathEdges(
  circularEdges: Map<string, CircularEdgeInfo[]>,
  path: string[],
  moduleMap: GraphOutput,
  fromKind: ItemNodeData["kind"],
  info: CircularEdgeInfo,
): void {
  for (let index = 0; index < path.length - 1; index += 1) {
    const fromId = resolveCycleNodeId(path[index] || "", moduleMap, fromKind);
    const toId = resolveCycleNodeId(path[index + 1] || "", moduleMap);
    if (!fromId || !toId) {
      continue;
    }

    addCircularEdgeInfo(circularEdges, `${toId}->${fromId}`, info);
  }
}

function providerCyclePathItemToKey(
  item: GraphOutputProviderCycle["path"][number],
): string {
  return `${item.module.name}:${item.provider.name}`;
}

function addCircularEdgeInfo(
  circularEdges: Map<string, CircularEdgeInfo[]>,
  edgeKey: string,
  info: CircularEdgeInfo,
): void {
  const existingInfo = circularEdges.get(edgeKey) || [];
  if (existingInfo.some((item) => item.id === info.id)) {
    return;
  }

  existingInfo.push(info);
  circularEdges.set(edgeKey, existingInfo);
}

function getCircularDependencyEdges(
  moduleMap: GraphOutput,
): Map<string, CircularEdgeInfo[]> {
  const circularEdges = new Map<string, CircularEdgeInfo[]>();
  addProviderDependencyCycleEdges(
    circularEdges,
    moduleMap.cycles?.providers,
    moduleMap,
  );
  addDependencyCycleEdges(
    circularEdges,
    moduleMap.cycles?.controllers,
    moduleMap,
    "controller",
  );

  return circularEdges;
}

function getCircularModuleEdges(
  moduleMap: GraphOutput,
): Map<string, CircularEdgeInfo[]> {
  const circularEdges = new Map<string, CircularEdgeInfo[]>();

  for (const [cycleIndex, cycle] of (
    moduleMap.cycles?.modules || []
  ).entries()) {
    const { from, to } = resolveCircularDependencyEndpoints(cycle.path);
    const info = {
      id: resolveCycleDisplayId(cycle, cycleIndex + 1),
      category: "module" as const,
      type: cycle.type,
      from,
      to,
      path: cycle.path,
    };

    for (let index = 0; index < cycle.path.length - 1; index += 1) {
      addCircularEdgeInfo(
        circularEdges,
        `${cycle.path[index + 1]}->${cycle.path[index]}`,
        info,
      );
    }
  }

  return circularEdges;
}

function getHierarchyRows(items: ModuleItemLayout[]): ModuleItemLayout[][] {
  const rows = new Map<number, ModuleItemLayout[]>();
  for (const item of items) {
    const row = rows.get(item.depth) || [];
    row.push(item);
    rows.set(item.depth, row);
  }

  return Array.from(rows.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row);
}

function calcModuleSize(
  moduleName: string,
  mod: GraphOutputModule,
  moduleMap: GraphOutput,
  isCollapsed = false,
): { width: number; height: number } {
  if (isCollapsed) {
    return { width: MODULE_MIN_WIDTH, height: MODULE_COLLAPSED_HEIGHT };
  }

  const itemCount = mod.providers.length + mod.controllers.length;
  if (itemCount === 0) {
    return {
      width: MODULE_MIN_WIDTH,
      height: MODULE_TITLE_HEIGHT + MODULE_PADDING * 2 + 16,
    };
  }

  const rows = getHierarchyRows(
    getModuleItemHierarchy(moduleName, mod, moduleMap),
  );
  const maxRowItemCount = Math.max(...rows.map((row) => row.length), 1);
  const width = Math.max(
    MODULE_MIN_WIDTH,
    MODULE_PADDING * 2 +
      maxRowItemCount * NODE_WIDTH +
      (maxRowItemCount - 1) * NODE_GAP_X,
  );
  const height =
    MODULE_TITLE_HEIGHT +
    MODULE_PADDING +
    rows.length * NODE_HEIGHT +
    Math.max(rows.length - 1, 0) * NODE_LEVEL_GAP_Y +
    MODULE_PADDING;

  return { width, height };
}

function pickHandles(
  sourcePos: { x: number; y: number },
  targetPos: { x: number; y: number },
): { sourceHandle: string; targetHandle: string } {
  const dx = targetPos.x - sourcePos.x;
  const dy = targetPos.y - sourcePos.y;

  if (dx === 0 && dy === 0) {
    return { sourceHandle: "source-bottom", targetHandle: "target-top" };
  }

  if (Math.abs(dy) >= Math.abs(dx)) {
    if (dy > 0) {
      return { sourceHandle: "source-bottom", targetHandle: "target-top" };
    }
    return { sourceHandle: "source-top", targetHandle: "target-bottom" };
  }

  if (dx > 0) {
    return { sourceHandle: "source-right", targetHandle: "target-left" };
  }
  return { sourceHandle: "source-left", targetHandle: "target-right" };
}

function pickDependencyHandles(
  sourcePos: { x: number; y: number },
  targetPos: { x: number; y: number },
): { sourceHandle: string; targetHandle: string } {
  if (Math.abs(targetPos.y - sourcePos.y) < NODE_HEIGHT) {
    if (targetPos.x >= sourcePos.x) {
      return { sourceHandle: "source-right", targetHandle: "target-left" };
    }

    return { sourceHandle: "source-left", targetHandle: "target-right" };
  }

  if (targetPos.y >= sourcePos.y) {
    return { sourceHandle: "source-bottom", targetHandle: "target-top" };
  }

  return { sourceHandle: "source-top", targetHandle: "target-bottom" };
}

function buildGraph(
  moduleMap: GraphOutput,
  collapsedModules = new Set<string>(),
  options: {
    showCircularDependencies?: boolean;
    showModuleToModuleLine?: boolean;
    showProviderToProviderInsideModule?: boolean;
    showProviderToProviderAcrossModule?: boolean;
    nodePositions?: Map<string, NodePosition>;
  } = {},
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const layers = assignLayers(moduleMap);
  const sortedLayers = Array.from(layers.entries()).sort((a, b) => a[0] - b[0]);
  const showCircularDependencies = options.showCircularDependencies ?? true;
  const showModuleToModuleLine = options.showModuleToModuleLine ?? true;
  const showProviderToProviderInsideModule =
    options.showProviderToProviderInsideModule ?? true;
  const showProviderToProviderAcrossModule =
    options.showProviderToProviderAcrossModule ?? false;
  const nodePositions =
    options.nodePositions ?? new Map<string, NodePosition>();
  const circularModuleEdges = showCircularDependencies
    ? getCircularModuleEdges(moduleMap)
    : new Map<string, CircularEdgeInfo[]>();
  const circularDependencyEdges = showCircularDependencies
    ? getCircularDependencyEdges(moduleMap)
    : new Map<string, CircularEdgeInfo[]>();
  const circularModuleEdgeLabels = showCircularDependencies
    ? deduplicateCircularEdgeLabels(circularModuleEdges)
    : new Map<string, CircularEdgeInfo[]>();
  const circularDependencyEdgeLabels = showCircularDependencies
    ? deduplicateCircularEdgeLabels(circularDependencyEdges)
    : new Map<string, CircularEdgeInfo[]>();

  const moduleSizes = new Map<string, { width: number; height: number }>();
  for (const [moduleName, mod] of Object.entries(moduleMap.modules)) {
    const isCollapsed =
      collapsedModules.has(moduleName) || !hasModuleComponents(mod);
    moduleSizes.set(
      moduleName,
      calcModuleSize(moduleName, mod, moduleMap, isCollapsed),
    );
  }

  const modulePositions = new Map<string, { x: number; y: number }>();
  const nodeAbsPositions = new Map<string, { x: number; y: number }>();
  let currentY = 0;

  for (const [, moduleNames] of sortedLayers) {
    const layerWidth = moduleNames.reduce(
      (sum, name) => {
        const size = moduleSizes.get(name);
        return sum + (size?.width || MODULE_MIN_WIDTH);
      },
      Math.max(moduleNames.length - 1, 0) * MODULE_GAP_X,
    );
    let currentX = -(layerWidth / 2);

    let maxHeight = 0;
    for (const name of moduleNames) {
      const size = moduleSizes.get(name) || {
        width: MODULE_MIN_WIDTH,
        height: MODULE_COLLAPSED_HEIGHT,
      };
      modulePositions.set(name, { x: currentX, y: currentY });
      maxHeight = Math.max(maxHeight, size.height);
      currentX += size.width + MODULE_GAP_X;
    }
    currentY += maxHeight + MODULE_GAP_Y;
  }

  for (const moduleName of Object.keys(moduleMap.modules)) {
    const savedPosition = nodePositions.get(`module-${moduleName}`);
    if (savedPosition) {
      modulePositions.set(moduleName, {
        x: savedPosition.x,
        y: savedPosition.y,
      });
    }
  }

  for (const [moduleName, mod] of Object.entries(moduleMap.modules)) {
    const pos = modulePositions.get(moduleName) || { x: 0, y: 0 };
    const isExpandable = hasModuleComponents(mod);
    const isCollapsed = collapsedModules.has(moduleName) || !isExpandable;
    const size =
      moduleSizes.get(moduleName) ||
      calcModuleSize(moduleName, mod, moduleMap, isCollapsed);

    nodes.push({
      id: `module-${moduleName}`,
      type: "module",
      position: { x: pos.x, y: pos.y },
      data: {
        label: moduleName,
        isRoot: moduleName === moduleMap.root,
        isCollapsed,
        isExpandable,
        minWidth: size.width,
        minHeight: size.height,
      },
      style: { width: `${size.width}px`, height: `${size.height}px` },
      class: (node) => getBrightLineNodeClass(node.id),
    });
  }

  for (const [moduleName, mod] of Object.entries(moduleMap.modules)) {
    if (collapsedModules.has(moduleName) || !hasModuleComponents(mod)) {
      continue;
    }

    const modPos = modulePositions.get(moduleName) || { x: 0, y: 0 };
    const moduleSize = moduleSizes.get(moduleName) || {
      width: MODULE_MIN_WIDTH,
      height: MODULE_COLLAPSED_HEIGHT,
    };
    const rows = getHierarchyRows(
      getModuleItemHierarchy(moduleName, mod, moduleMap),
    );

    for (const [rowIndex, row] of rows.entries()) {
      const rowWidth =
        row.length * NODE_WIDTH + Math.max(row.length - 1, 0) * NODE_GAP_X;
      const startX = Math.max(
        MODULE_PADDING,
        (moduleSize.width - rowWidth) / 2,
      );
      const childY =
        MODULE_TITLE_HEIGHT +
        MODULE_PADDING +
        rowIndex * (NODE_HEIGHT + NODE_LEVEL_GAP_Y);

      for (const [itemIndex, item] of row.entries()) {
        const childX = startX + itemIndex * (NODE_WIDTH + NODE_GAP_X);
        const savedPosition = nodePositions.get(item.id);
        const itemPosition = savedPosition
          ? { x: savedPosition.x, y: savedPosition.y }
          : { x: childX, y: childY };
        nodeAbsPositions.set(item.id, {
          x: modPos.x + itemPosition.x + NODE_WIDTH / 2,
          y: modPos.y + itemPosition.y + NODE_HEIGHT / 2,
        });
        nodes.push({
          id: item.id,
          type: "item",
          position: itemPosition,
          parentNode: `module-${moduleName}`,
          extent: "parent",
          draggable: true,
          data: {
            label: item.label,
            kind: item.kind,
            isExported: item.isExported,
          },
          style: { width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px` },
          class: (node) => getBrightLineNodeClass(node.id),
        });
      }
    }
  }

  for (const [moduleName, mod] of Object.entries(moduleMap.modules)) {
    for (const imp of mod.imports) {
      if (moduleMap.modules[imp]) {
        const sourcePos = modulePositions.get(imp);
        const targetPos = modulePositions.get(moduleName);
        if (!sourcePos || !targetPos) {
          continue;
        }

        const { sourceHandle, targetHandle } = pickHandles(
          sourcePos,
          targetPos,
        );
        const circularInfo = circularModuleEdges.get(`${imp}->${moduleName}`);
        const circularLabelInfo = circularModuleEdgeLabels.get(
          `${imp}->${moduleName}`,
        );
        const edgeColor = circularInfo
          ? CIRCULAR_DEPENDENCY_EDGE_COLOR
          : MODULE_EDGE_COLOR;

        edges.push({
          id: `e-mod-${imp}->${moduleName}`,
          source: `module-${imp}`,
          target: `module-${moduleName}`,
          sourceHandle,
          targetHandle,
          type: circularLabelInfo ? "warning" : "smoothstep",
          style: { stroke: edgeColor, strokeWidth: circularInfo ? 2.2 : 1.5 },
          class: (edge) =>
            getBrightLineEdgeClass(
              edge.source,
              edge.target,
              edge.data?.isNormallyVisible ?? true,
            ),
          markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor },
          ...getEdgeDataProps(circularLabelInfo, showModuleToModuleLine),
        });
      }
    }
  }

  function addDependencyEdge(
    sourceId: string,
    targetId: string,
    isNormallyVisible: boolean,
  ): void {
    const sPos = nodeAbsPositions.get(sourceId);
    const tPos = nodeAbsPositions.get(targetId);
    if (!sPos || !tPos) {
      return;
    }

    const { sourceHandle, targetHandle } = pickDependencyHandles(sPos, tPos);
    const circularInfo = circularDependencyEdges.get(
      `${sourceId}->${targetId}`,
    );
    const circularLabelInfo = circularDependencyEdgeLabels.get(
      `${sourceId}->${targetId}`,
    );
    const edgeColor = circularInfo
      ? CIRCULAR_DEPENDENCY_EDGE_COLOR
      : DEPENDENCY_EDGE_COLOR;

    edges.push({
      id: `e-dep-${sourceId}->${targetId}`,
      source: sourceId,
      target: targetId,
      sourceHandle,
      targetHandle,
      type: circularLabelInfo ? "warning" : "smoothstep",
      style: {
        stroke: edgeColor,
        strokeWidth: circularInfo ? 2.2 : 1.5,
      },
      class: (edge) =>
        getBrightLineEdgeClass(
          edge.source,
          edge.target,
          edge.data?.isNormallyVisible ?? true,
        ),
      markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor },
      ...getEdgeDataProps(circularLabelInfo, isNormallyVisible),
    });
  }

  function addModuleItemDependencyEdges(): void {
    for (const [moduleName, mod] of Object.entries(moduleMap.modules)) {
      for (const provider of mod.providers) {
        for (const dep of provider.dependencies) {
          const sourceId = resolveDepNodeId(dep, moduleName, moduleMap);
          const targetId = `provider-${moduleName}-${provider.name}`;
          if (sourceId) {
            const isNormallyVisible = isNodeInModule(sourceId, moduleName)
              ? showProviderToProviderInsideModule
              : showProviderToProviderAcrossModule;
            addDependencyEdge(sourceId, targetId, isNormallyVisible);
          }
        }
      }

      for (const controller of mod.controllers) {
        for (const dep of controller.dependencies) {
          const sourceId = resolveDepNodeId(dep, moduleName, moduleMap);
          const targetId = `controller-${moduleName}-${controller.name}`;
          if (sourceId) {
            const isNormallyVisible = isNodeInModule(sourceId, moduleName)
              ? showProviderToProviderInsideModule
              : showProviderToProviderAcrossModule;
            addDependencyEdge(sourceId, targetId, isNormallyVisible);
          }
        }
      }
    }
  }

  addModuleItemDependencyEdges();

  return { nodes, edges };
}

const collapsedModuleNames = ref<Set<string>>(
  getInitialCollapsedModuleNames(graphData.value),
);
const showGraphSettings = ref(false);
const autoAdjustGraphView = ref(true);
const showLegends = ref(true);
const showBrightLine = ref(props.enableBrightLine);
const activeBrightLineNodeId = ref<string | null>(null);
const hasInitialFixedBrightLine =
  props.enableBrightLine &&
  props.fixBightline !== false &&
  props.fixBightline !== undefined;
const showModuleToModuleLine = ref(!hasInitialFixedBrightLine);
const showProviderToProviderInsideModule = ref(!hasInitialFixedBrightLine);
const showProviderToProviderAcrossModule = ref(false);
const directRunStateByNodeId = ref<Record<string, DirectRunExecutionSnapshot>>(
  {},
);
const selectedProviderNodeId = ref<string | null>(null);
const directRunPendingMethodByNodeId = ref<Record<string, string>>({});
const directRunPendingModeByNodeId = ref<Record<string, DirectRunMode>>({});
const directRunErrorByNodeId = ref<Record<string, string>>({});
const directRunArgsInputByKey = ref<Record<string, string>>({});
const directRunArgsErrorByKey = ref<Record<string, string>>({});
const directRunArgsInvalidByKey = ref<Record<string, boolean>>({});
const directRunActiveTab = ref<string>("");
const showStaticDirectRunDialog = ref(false);
const directRunArgsSchemaCache = new Map<
  string,
  DirectRunArgsSchemaCacheEntry
>();
const initialGraph = buildGraph(graphData.value, collapsedModuleNames.value, {
  showCircularDependencies: showCircularDependencies.value,
  showModuleToModuleLine: showModuleToModuleLine.value,
  showProviderToProviderInsideModule: showProviderToProviderInsideModule.value,
  showProviderToProviderAcrossModule: showProviderToProviderAcrossModule.value,
});

const flowNodes = shallowRef<FlowNode[]>(initialGraph.nodes);
const flowEdges = shallowRef<FlowEdge[]>(initialGraph.edges);
const nodePositionOverrides = new Map<string, NodePosition>();
const activeCircularTooltipEdgeId = ref<string | null>(null);
const showCircularDetailDialog = ref(false);
const circularDetailDialogData = ref<CircularEdgeDialogData | null>(null);
const fixedBrightLineTarget = computed(() => {
  if (!props.enableBrightLine) {
    return null;
  }

  if (props.fixBightline === false || props.fixBightline === undefined) {
    return null;
  }

  if (typeof props.fixBightline === "string") {
    const target = props.fixBightline.trim();
    return target || DEFAULT_FIXED_BRIGHT_LINE_TARGET;
  }

  return DEFAULT_FIXED_BRIGHT_LINE_TARGET;
});
const activeBrightLineConnectedNodeIds = computed(() => {
  const activeNodeId = activeBrightLineNodeId.value;
  const connectedNodeIds = new Set<string>();
  if (!showBrightLine.value || !activeNodeId) {
    return connectedNodeIds;
  }

  const edgesByNodeId = new Map<string, FlowEdge[]>();
  for (const edge of flowEdges.value) {
    const sourceEdges = edgesByNodeId.get(edge.source) || [];
    sourceEdges.push(edge);
    edgesByNodeId.set(edge.source, sourceEdges);
  }

  const queue = [activeNodeId];
  connectedNodeIds.add(activeNodeId);

  while (queue.length > 0) {
    const currentNodeId = queue.shift();
    if (!currentNodeId) {
      continue;
    }

    for (const edge of edgesByNodeId.get(currentNodeId) || []) {
      const nextNodeId = edge.target;
      if (connectedNodeIds.has(nextNodeId)) {
        continue;
      }

      connectedNodeIds.add(nextNodeId);
      queue.push(nextNodeId);
    }
  }

  return connectedNodeIds;
});
const expandableModuleNames = computed(() =>
  Object.entries(graphData.value.modules)
    .filter(([, mod]) => hasModuleComponents(mod))
    .map(([moduleName]) => moduleName),
);
const allModulesOpenState = computed<boolean | "indeterminate">(() => {
  if (expandableModuleNames.value.length === 0) {
    return false;
  }

  const openModuleCount = expandableModuleNames.value.filter(
    (moduleName) => !collapsedModuleNames.value.has(moduleName),
  ).length;

  if (openModuleCount === 0) {
    return false;
  }

  if (openModuleCount === expandableModuleNames.value.length) {
    return true;
  }

  return "indeterminate";
});
const selectedProviderContext = computed<DirectRunProviderContext | null>(
  () => {
    const nodeId = selectedProviderNodeId.value;
    if (!nodeId) {
      return null;
    }

    const parsed = parseProviderNodeId(nodeId);
    if (!parsed) {
      return null;
    }

    const provider = graphData.value.modules[parsed.moduleName]?.providers.find(
      (item) => item.name === parsed.providerName,
    );

    if (!provider) {
      return null;
    }

    return {
      nodeId,
      moduleName: parsed.moduleName,
      provider,
    };
  },
);
const selectedProviderDirectRunState = computed(() => {
  const context = selectedProviderContext.value;
  return context ? getDirectRunProviderState(context.provider) : null;
});
const showDirectRunDrawer = computed({
  get: () => Boolean(selectedProviderContext.value),
  set: (value: boolean) => {
    if (!value) {
      const hadSelectedProvider = Boolean(selectedProviderNodeId.value);
      selectedProviderNodeId.value = null;
      if (hadSelectedProvider || !props.directRunOn) {
        emit("directRunDrawerClose");
      }
    }
  },
});

function findProviderNodeId(providerName: string): string | null {
  for (const [moduleName, moduleData] of Object.entries(graphData.value.modules)) {
    if (moduleData.providers.some((provider) => provider.name === providerName)) {
      return getProviderNodeId(moduleName, providerName);
    }
  }

  return null;
}

function syncDirectRunOn(): void {
  const nodeId = props.directRunOn ? findProviderNodeId(props.directRunOn) : null;
  if (nodeId && selectedProviderNodeId.value !== nodeId) {
    selectedProviderNodeId.value = nodeId;
  }
}

const directRunMethodTabs = computed<DirectRunMethodTab[]>(() =>
  (selectedProviderDirectRunState.value?.methods || []).map((method) => {
    const parameterCount = getDirectRunParameterCount(method);

    return {
      label: method.name,
      value: method.name,
      method,
      badge: parameterCount
        ? `${parameterCount} ${parameterCount === 1 ? "arg" : "args"}`
        : undefined,
    };
  }),
);
const selectedProviderSnapshot = computed(() => {
  const nodeId = selectedProviderContext.value?.nodeId;
  return nodeId ? directRunStateByNodeId.value[nodeId] || null : null;
});
const selectedProviderPendingMethod = computed(() => {
  const nodeId = selectedProviderContext.value?.nodeId;
  return nodeId ? directRunPendingMethodByNodeId.value[nodeId] || "" : "";
});
const selectedProviderPendingMode = computed(() => {
  const nodeId = selectedProviderContext.value?.nodeId;
  return nodeId ? directRunPendingModeByNodeId.value[nodeId] || "" : "";
});
const selectedProviderError = computed(() => {
  const nodeId = selectedProviderContext.value?.nodeId;
  return nodeId ? directRunErrorByNodeId.value[nodeId] || "" : "";
});
const selectedProviderArgsErrors = computed<Record<string, string>>(() => {
  const context = selectedProviderContext.value;
  if (!context) {
    return {};
  }

  return Object.fromEntries(
    (selectedProviderDirectRunState.value?.methods || []).map((method) => [
      method.name,
      directRunArgsErrorByKey.value[
        directRunArgsKey(context.nodeId, method.name)
      ] || "",
    ]),
  );
});
const selectedProviderLastRunLabel = computed(() => {
  const value = selectedProviderSnapshot.value?.updatedAt;
  if (!value) {
    return "";
  }

  return new Date(value).toLocaleString();
});
const selectedProviderStatusBadge = computed<DirectRunStatusBadge | null>(
  () => {
    const context = selectedProviderContext.value;
    if (!context) {
      return null;
    }

    const directRunState = selectedProviderDirectRunState.value;
    if (!directRunState) {
      return null;
    }

    if (!directRunState.runnable) {
      return {
        label: "Not runnable",
        color: "neutral",
        variant: "outline",
      };
    }

    const pendingMethod = selectedProviderPendingMethod.value;
    if (pendingMethod) {
      return {
        label: "Running",
        color: "primary",
        variant: "solid",
      };
    }

    if (selectedProviderError.value) {
      return {
        label: "Failed",
        color: "error",
        variant: "solid",
      };
    }

    const snapshot = selectedProviderSnapshot.value;
    if (!snapshot) {
      return {
        label: "Idle",
        color: "neutral",
        variant: "soft",
      };
    }

    return snapshot.state === "success"
      ? {
          label: "Success",
          color: "success",
          variant: "solid",
        }
      : {
          label: "Failed",
          color: "error",
          variant: "solid",
        };
  },
);

function resolveBrightLineNodeId(target: string): string | null {
  const matchedNode = flowNodes.value.find(
    (node) =>
      node.id === target ||
      node.data?.label === target ||
      node.id.endsWith(`-${target}`),
  );

  return matchedNode?.id || null;
}

function syncFixedBrightLineNode(): void {
  const target = fixedBrightLineTarget.value;
  if (!target) {
    return;
  }

  activeBrightLineNodeId.value = resolveBrightLineNodeId(target);
}

function hasActiveBrightLine(): boolean {
  return showBrightLine.value && activeBrightLineNodeId.value !== null;
}

function getBrightLineNodeClass(nodeId: string): string[] {
  if (!hasActiveBrightLine()) {
    return [];
  }

  if (activeBrightLineNodeId.value === nodeId) {
    const classes = [BRIGHT_LINE_NODE_CLASS, BRIGHT_LINE_NODE_ACTIVE_CLASS];
    const fixedTarget = fixedBrightLineTarget.value;
    if (fixedTarget && resolveBrightLineNodeId(fixedTarget) === nodeId) {
      classes.push(BRIGHT_LINE_NODE_FIXED_CLASS);
    }

    return classes;
  }

  if (activeBrightLineConnectedNodeIds.value.has(nodeId)) {
    return [BRIGHT_LINE_NODE_CLASS, BRIGHT_LINE_NODE_CONNECTED_CLASS];
  }

  return [BRIGHT_LINE_NODE_DIMMED_CLASS];
}

function isBrightLineEdgeActive(sourceId: string, targetId: string): boolean {
  const activeNodeId = activeBrightLineNodeId.value;
  if (!showBrightLine.value || !activeNodeId) {
    return false;
  }

  const connectedNodeIds = activeBrightLineConnectedNodeIds.value;
  return connectedNodeIds.has(sourceId) && connectedNodeIds.has(targetId);
}

function getBrightLineEdgeClass(
  sourceId: string,
  targetId: string,
  isNormallyVisible: boolean,
): string[] {
  if (isBrightLineEdgeActive(sourceId, targetId)) {
    return [BRIGHT_LINE_EDGE_CLASS];
  }

  if (!isNormallyVisible) {
    return [BRIGHT_LINE_EDGE_HIDDEN_CLASS];
  }

  if (hasActiveBrightLine()) {
    return [BRIGHT_LINE_EDGE_DIMMED_CLASS];
  }

  return [];
}

function shouldShowCircularEdgeWarning(
  sourceId: string,
  targetId: string,
  edgeData: CircularEdgeData,
): boolean {
  return (
    edgeData.isNormallyVisible || isBrightLineEdgeActive(sourceId, targetId)
  );
}

function setActiveBrightLineNode(event: NodeMouseEvent): void {
  if (!props.enableBrightLine) {
    return;
  }

  activeBrightLineNodeId.value = event.node.id;
}

function clearActiveBrightLineNode(event?: NodeMouseEvent): void {
  if (!props.enableBrightLine) {
    activeBrightLineNodeId.value = null;
    return;
  }

  if (fixedBrightLineTarget.value) {
    if (!event || activeBrightLineNodeId.value === event.node.id) {
      syncFixedBrightLineNode();
    }
    return;
  }

  if (!event || activeBrightLineNodeId.value === event.node.id) {
    activeBrightLineNodeId.value = null;
  }
}

function selectProviderNode(nodeId: string | null): void {
  const providerNode = nodeId ? parseProviderNodeId(nodeId) : null;

  if (nodeId && providerNode) {
    selectedProviderNodeId.value = nodeId;
    emit("directRunDrawerOpen", providerNode.providerName);
    return;
  }

  selectedProviderNodeId.value = null;
  emit("directRunDrawerClose");
}

function handleNodeClick(event: NodeMouseEvent): void {
  selectProviderNode(event.node.id);
}

function clearDirectRunPending(nodeId: string): void {
  const { [nodeId]: _removed, ...nextPendingState } =
    directRunPendingMethodByNodeId.value;
  const { [nodeId]: _removedMode, ...nextPendingModeState } =
    directRunPendingModeByNodeId.value;
  directRunPendingMethodByNodeId.value = nextPendingState;
  directRunPendingModeByNodeId.value = nextPendingModeState;
}

function setDirectRunError(nodeId: string, error: string): void {
  directRunErrorByNodeId.value = {
    ...directRunErrorByNodeId.value,
    [nodeId]: error,
  };
}

function clearDirectRunError(nodeId: string): void {
  const { [nodeId]: _removed, ...nextErrorState } =
    directRunErrorByNodeId.value;
  directRunErrorByNodeId.value = nextErrorState;
}

function directRunArgsKey(nodeId: string, methodName: string): string {
  return `${nodeId}:${methodName}`;
}

function getDirectRunMethodSignature(method: DirectRunProviderMethod): string {
  const parameters = getDirectRunParameterInfos(method);
  if (parameters.length === 0) {
    return `${method.name}()`;
  }

  const args = parameters.map((parameter) => parameter.name).join(", ");

  return `${method.name}(${args})`;
}

function getDirectRunParameterCount(method: DirectRunProviderMethod): number {
  return getDirectRunParameterInfos(method).length;
}

function getDirectRunParameterInfos(
  method: DirectRunProviderMethod,
): DirectRunParameterInfo[] {
  const parameterTypes = method.parameterTypes?.trim() || "[]";
  const tupleBody = parseDirectRunTupleBody(parameterTypes);
  if (!tupleBody) {
    return [];
  }

  return splitTopLevel(tupleBody, ",").map(
    (parameter, index): DirectRunParameterInfo => {
      const separatorIndex = findTopLevelSeparator(parameter, ":");
      const rawName =
        separatorIndex >= 0
          ? parameter.slice(0, separatorIndex).trim()
          : `arg${index + 1}`;
      const type =
        separatorIndex >= 0
          ? parameter.slice(separatorIndex + 1).trim() || "unknown"
          : parameter.trim() || "unknown";
      const name = sanitizeDirectRunParameterName(rawName) || `arg${index + 1}`;

      return {
        name,
        type,
        schema: typeScriptTypeToJsonSchema(type),
      };
    },
  );
}

function parseDirectRunTupleBody(parameterTypes: string): string {
  const trimmed = stripOuterParens(parameterTypes.trim());
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return "";
  }

  return trimmed.slice(1, -1).trim();
}

function sanitizeDirectRunParameterName(name: string): string {
  return name
    .replace(/^\.\.\./, "")
    .replace(/^readonly\s+/, "")
    .replace(/\?$/, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function getDirectRunEditorPath(methodName: string): string {
  const context = selectedProviderContext.value;
  if (!context) {
    return `direct-run://${methodName}.json`;
  }

  return `direct-run://${context.moduleName}/${context.provider.name}/${methodName}.json`;
}

function getDirectRunArgsSchema(
  method: DirectRunProviderMethod,
): DirectRunArgsJsonSchema {
  const context = selectedProviderContext.value;
  const cacheKey = context
    ? directRunArgsKey(context.nodeId, method.name)
    : method.name;
  const fingerprint = method.parameterTypes || "[]";
  const cachedSchema = directRunArgsSchemaCache.get(cacheKey);
  if (cachedSchema?.fingerprint === fingerprint) {
    return cachedSchema.schema;
  }

  const schema = buildDirectRunArgsSchema(method);
  directRunArgsSchemaCache.set(cacheKey, {
    fingerprint,
    schema,
  });

  return schema;
}

function buildDirectRunArgsSchema(
  method: DirectRunProviderMethod,
): DirectRunArgsJsonSchema {
  const parameters = getDirectRunParameterInfos(method);
  const parameterCount = parameters.length;

  if (parameterCount === 0) {
    return {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: `${method.name}() arguments`,
      description: "JSON array passed as method arguments.",
      type: "array",
      minItems: 0,
      maxItems: 0,
      items: [],
    };
  }

  if (parameterCount === 1) {
    const parameter = parameters[0];
    const parameterName = parameter?.name || "argument";
    const parameterType = parameter?.type || "unknown";
    const parameterSchema = parameter?.schema || {};

    return {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: `${method.name}() arguments`,
      description: `JSON array passed as ${parameterName}: ${parameterType}.`,
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: [
        {
          title: parameterName,
          description: parameterType,
          ...parameterSchema,
        },
      ],
    };
  }

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: `${method.name}() arguments`,
    description: `JSON array passed as ${parameterCount} method arguments.`,
    type: "array",
    minItems: parameterCount,
    maxItems: parameterCount,
    items: parameters.map(
      (parameter): DirectRunArgsJsonSchema => ({
        title: parameter.name,
        description: parameter.type,
        ...parameter.schema,
      }),
    ),
  };
}

function typeScriptTypeToJsonSchema(typeText: string): DirectRunArgsJsonSchema {
  const type = stripOuterParens(typeText.trim());
  if (!type || type === "unknown" || type === "any") {
    return {};
  }

  if (type === "string") {
    return { type: "string" };
  }
  if (type === "number") {
    return { type: "number" };
  }
  if (type === "boolean") {
    return { type: "boolean" };
  }
  if (type === "null") {
    return { type: "null" };
  }
  if (type === "object") {
    return { type: "object" };
  }

  const literal = parseTypeScriptLiteral(type);
  if (literal.matched) {
    return { enum: [literal.value] };
  }

  const rawUnionTypes = splitTopLevel(type, "|");
  const unionTypes = rawUnionTypes
    .map((candidate) => candidate.trim())
    .filter(
      (candidate) =>
        candidate && candidate !== "undefined" && candidate !== "void",
    );
  if (rawUnionTypes.length > 1) {
    if (unionTypes.length === 1) {
      return typeScriptTypeToJsonSchema(unionTypes[0] || "unknown");
    }

    const literals = unionTypes.map(parseTypeScriptLiteral);
    if (literals.every((candidate) => candidate.matched)) {
      return { enum: literals.map((candidate) => candidate.value) };
    }

    return {
      anyOf: unionTypes.map((candidate) =>
        typeScriptTypeToJsonSchema(candidate),
      ),
    };
  }

  if (isArrayType(type)) {
    return {
      type: "array",
      items: typeScriptTypeToJsonSchema(type.slice(0, -2)),
    };
  }

  if (type.startsWith("[") && type.endsWith("]")) {
    const tupleItems = splitTopLevel(type.slice(1, -1), ",").map((item) =>
      typeScriptTypeToJsonSchema(item),
    );

    return {
      type: "array",
      minItems: tupleItems.length,
      maxItems: tupleItems.length,
      items: tupleItems,
    };
  }

  if (type.startsWith("{") && type.endsWith("}")) {
    return objectTypeToJsonSchema(type.slice(1, -1));
  }

  return {};
}

function objectTypeToJsonSchema(typeBody: string): DirectRunArgsJsonSchema {
  const properties: Record<string, DirectRunArgsJsonSchema> = {};
  const required: string[] = [];

  for (const member of splitTopLevelAny(typeBody, [";", ","])) {
    const separatorIndex = findTopLevelSeparator(member, ":");
    if (separatorIndex <= 0) {
      continue;
    }

    const rawName = member.slice(0, separatorIndex).trim();
    const propertyType = member.slice(separatorIndex + 1).trim();
    const optional = rawName.endsWith("?");
    const name = sanitizeDirectRunParameterName(rawName);
    if (!name) {
      continue;
    }

    properties[name] = typeScriptTypeToJsonSchema(propertyType);
    if (!optional && !typeIncludesUndefined(propertyType)) {
      required.push(name);
    }
  }

  return {
    type: "object",
    additionalProperties: true,
    properties,
    required,
  };
}

function stripOuterParens(value: string): string {
  let next = value.trim();
  while (
    next.startsWith("(") &&
    next.endsWith(")") &&
    enclosesWholeValue(next)
  ) {
    next = next.slice(1, -1).trim();
  }

  return next;
}

function enclosesWholeValue(value: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0 && index < value.length - 1) {
        return false;
      }
    }
  }

  return depth === 0;
}

function splitTopLevel(value: string, separator: string): string[] {
  return splitTopLevelAny(value, [separator]);
}

function splitTopLevelAny(value: string, separators: string[]): string[] {
  const parts: string[] = [];
  let start = 0;
  let angleDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] || "";
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }

    if (character === "{") {
      braceDepth += 1;
    } else if (character === "}") {
      braceDepth -= 1;
    } else if (character === "[") {
      bracketDepth += 1;
    } else if (character === "]") {
      bracketDepth -= 1;
    } else if (character === "(") {
      parenDepth += 1;
    } else if (character === ")") {
      parenDepth -= 1;
    } else if (character === "<") {
      angleDepth += 1;
    } else if (character === ">") {
      angleDepth -= 1;
    } else if (
      separators.includes(character) &&
      angleDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenDepth === 0
    ) {
      const part = value.slice(start, index).trim();
      if (part) {
        parts.push(part);
      }
      start = index + 1;
    }
  }

  const part = value.slice(start).trim();
  if (part) {
    parts.push(part);
  }

  return parts;
}

function findTopLevelSeparator(value: string, separator: string): number {
  let angleDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }

    if (character === "{") {
      braceDepth += 1;
    } else if (character === "}") {
      braceDepth -= 1;
    } else if (character === "[") {
      bracketDepth += 1;
    } else if (character === "]") {
      bracketDepth -= 1;
    } else if (character === "(") {
      parenDepth += 1;
    } else if (character === ")") {
      parenDepth -= 1;
    } else if (character === "<") {
      angleDepth += 1;
    } else if (character === ">") {
      angleDepth -= 1;
    } else if (
      character === separator &&
      angleDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenDepth === 0
    ) {
      return index;
    }
  }

  return -1;
}

function parseTypeScriptLiteral(
  value: string,
): { matched: true; value: unknown } | { matched: false } {
  if (/^'(?:\\.|[^'\\])*'$/.test(value) || /^"(?:\\.|[^"\\])*"$/.test(value)) {
    try {
      const normalizedValue = value.startsWith("'")
        ? JSON.stringify(value.slice(1, -1).replace(/\\'/g, "'"))
        : value;

      return { matched: true, value: JSON.parse(normalizedValue) };
    } catch {
      return { matched: true, value: value.slice(1, -1) };
    }
  }

  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return { matched: true, value: Number(value) };
  }
  if (value === "true") {
    return { matched: true, value: true };
  }
  if (value === "false") {
    return { matched: true, value: false };
  }
  if (value === "null") {
    return { matched: true, value: null };
  }

  return { matched: false };
}

function isArrayType(type: string): boolean {
  return type.endsWith("[]") && stripOuterParens(type.slice(0, -2)).length > 0;
}

function typeIncludesUndefined(type: string): boolean {
  return splitTopLevel(type, "|").some(
    (candidate) => candidate.trim() === "undefined",
  );
}

function getDirectRunArgsInput(methodName: string): string {
  const nodeId = selectedProviderContext.value?.nodeId;
  return nodeId
    ? directRunArgsInputByKey.value[directRunArgsKey(nodeId, methodName)] || ""
    : "";
}

function setDirectRunArgsInput(methodName: string, value: unknown): void {
  const nodeId = selectedProviderContext.value?.nodeId;
  if (!nodeId) {
    return;
  }

  const key = directRunArgsKey(nodeId, methodName);
  directRunArgsInputByKey.value = {
    ...directRunArgsInputByKey.value,
    [key]: typeof value === "string" ? value : String(value ?? ""),
  };

  const { [key]: _removed, ...nextArgsErrorState } =
    directRunArgsErrorByKey.value;
  directRunArgsErrorByKey.value = nextArgsErrorState;
}

function setDirectRunArgsValidation(
  methodName: string,
  markers: DirectRunEditorMarker[],
): void {
  const nodeId = selectedProviderContext.value?.nodeId;
  if (!nodeId) {
    return;
  }

  directRunArgsInvalidByKey.value = {
    ...directRunArgsInvalidByKey.value,
    [directRunArgsKey(nodeId, methodName)]: markers.some(
      (marker) => marker.severity >= 8,
    ),
  };
}

function hasDirectRunArgsValidationError(methodName: string): boolean {
  const nodeId = selectedProviderContext.value?.nodeId;
  return nodeId
    ? Boolean(
        directRunArgsInvalidByKey.value[directRunArgsKey(nodeId, methodName)],
      )
    : false;
}

function isDirectRunActionDisabled(method: DirectRunProviderMethod): boolean {
  if (!props.directRunUrl) {
    return true;
  }

  if (props.directRunDisabled) {
    return false;
  }

  if (selectedProviderPendingMethod.value) {
    return true;
  }

  if (getDirectRunParameterCount(method) === 0) {
    return false;
  }

  return (
    !parseDirectRunArgs(method, getDirectRunArgsInput(method.name)).ok ||
    hasDirectRunArgsValidationError(method.name)
  );
}

function openStaticDirectRunDialog(): void {
  showStaticDirectRunDialog.value = true;
}

function openExecutionSequenceHistory(): void {
  showStaticDirectRunDialog.value = false;
  emit("executionSequenceOpen");
}

function handleDirectRunAction(
  method: DirectRunProviderMethod,
  mode: DirectRunMode,
): void {
  if (props.directRunDisabled) {
    openStaticDirectRunDialog();
    return;
  }

  void requestDirectRun(method, mode);
}

function getDirectRunArgsError(method: DirectRunProviderMethod): string {
  const storedError = selectedProviderArgsErrors.value[method.name];
  if (storedError) {
    return storedError;
  }

  const input = getDirectRunArgsInput(method.name);
  if (!input.trim()) {
    return "";
  }

  const parsedArgs = parseDirectRunArgs(method, input);
  return parsedArgs.ok ? "" : parsedArgs.error;
}

function setDirectRunArgsError(
  nodeId: string,
  methodName: string,
  error: string,
): void {
  directRunArgsErrorByKey.value = {
    ...directRunArgsErrorByKey.value,
    [directRunArgsKey(nodeId, methodName)]: error,
  };
}

function clearDirectRunArgsError(nodeId: string, methodName: string): void {
  const key = directRunArgsKey(nodeId, methodName);
  const { [key]: _removed, ...nextArgsErrorState } =
    directRunArgsErrorByKey.value;
  directRunArgsErrorByKey.value = nextArgsErrorState;
}

function parseDirectRunArgs(
  method: DirectRunProviderMethod,
  input: string,
): { ok: true; args: unknown[] | undefined } | { ok: false; error: string } {
  const parameterCount = getDirectRunParameterCount(method);
  if (parameterCount === 0) {
    return { ok: true, args: undefined };
  }

  const trimmedInput = input.trim();
  if (!trimmedInput) {
    return {
      ok: false,
      error: `Enter JSON arguments for ${method.name}().`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedInput);
  } catch {
    return {
      ok: false,
      error: "Arguments must be valid JSON.",
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: `${method.name}() expects ${parameterCount} arguments. Use a JSON array.`,
    };
  }

  const validationError = validateDirectRunParsedArgs(method, parsed);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  return { ok: true, args: parsed };
}

function validateDirectRunParsedArgs(
  method: DirectRunProviderMethod,
  args: unknown[],
): string {
  const parameters = getDirectRunParameterInfos(method);
  const parameterCount = parameters.length;
  if (args.length !== parameterCount) {
    return `${method.name}() expects ${parameterCount} arguments.`;
  }

  for (let index = 0; index < parameterCount; index += 1) {
    const parameter = parameters[index];
    const error = validateJsonSchemaValue(
      args[index],
      parameter?.schema || {},
      parameter?.name || `arg${index + 1}`,
    );
    if (error) {
      return error;
    }
  }

  return "";
}

function validateJsonSchemaValue(
  value: unknown,
  schema: DirectRunArgsJsonSchema,
  label: string,
): string {
  if (schema.enum && Array.isArray(schema.enum)) {
    const matchesEnum = schema.enum.some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(value),
    );
    if (!matchesEnum) {
      return `${label} must be one of ${schema.enum.map(String).join(", ")}.`;
    }
  }

  const unionSchemas = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (unionSchemas) {
    const hasMatch = unionSchemas.some(
      (candidate) =>
        !validateJsonSchemaValue(
          value,
          candidate as DirectRunArgsJsonSchema,
          label,
        ),
    );
    return hasMatch ? "" : `${label} does not match the expected type.`;
  }

  const typeError = validateJsonSchemaType(value, schema, label);
  if (typeError) {
    return typeError;
  }

  if (Array.isArray(value)) {
    return validateJsonSchemaArray(value, schema, label);
  }

  if (value && typeof value === "object") {
    return validateJsonSchemaObject(
      value as Record<string, unknown>,
      schema,
      label,
    );
  }

  return "";
}

function validateJsonSchemaType(
  value: unknown,
  schema: DirectRunArgsJsonSchema,
  label: string,
): string {
  const schemaType = schema.type;
  const allowedTypes = Array.isArray(schemaType)
    ? schemaType
    : typeof schemaType === "string"
      ? [schemaType]
      : [];

  if (allowedTypes.length === 0) {
    return "";
  }

  const isValid = allowedTypes.some((type) => {
    if (type === "string") {
      return typeof value === "string";
    }
    if (type === "number") {
      return typeof value === "number" && Number.isFinite(value);
    }
    if (type === "integer") {
      return Number.isInteger(value);
    }
    if (type === "boolean") {
      return typeof value === "boolean";
    }
    if (type === "array") {
      return Array.isArray(value);
    }
    if (type === "object") {
      return (
        Boolean(value) && typeof value === "object" && !Array.isArray(value)
      );
    }
    if (type === "null") {
      return value === null;
    }
    return true;
  });

  return isValid ? "" : `${label} must be ${allowedTypes.join(" or ")}.`;
}

function validateJsonSchemaArray(
  value: unknown[],
  schema: DirectRunArgsJsonSchema,
  label: string,
): string {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    return `${label} must contain at least ${schema.minItems} items.`;
  }

  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    return `${label} must contain at most ${schema.maxItems} items.`;
  }

  if (Array.isArray(schema.items)) {
    for (let index = 0; index < schema.items.length; index += 1) {
      const error = validateJsonSchemaValue(
        value[index],
        schema.items[index] as DirectRunArgsJsonSchema,
        `${label}[${index}]`,
      );
      if (error) {
        return error;
      }
    }
    return "";
  }

  if (schema.items && typeof schema.items === "object") {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateJsonSchemaValue(
        value[index],
        schema.items as DirectRunArgsJsonSchema,
        `${label}[${index}]`,
      );
      if (error) {
        return error;
      }
    }
  }

  return "";
}

function validateJsonSchemaObject(
  value: Record<string, unknown>,
  schema: DirectRunArgsJsonSchema,
  label: string,
): string {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return `${label}.${key} is required.`;
    }
  }

  const properties = schema.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return "";
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }

    const error = validateJsonSchemaValue(
      value[key],
      propertySchema as DirectRunArgsJsonSchema,
      `${label}.${key}`,
    );
    if (error) {
      return error;
    }
  }

  return "";
}

async function executeDirectRun(
  request: DirectRunActionRequest,
  mode: DirectRunMode,
): Promise<void> {
  const nodeId = `provider-${request.moduleName}-${request.providerName}`;

  directRunPendingMethodByNodeId.value = {
    ...directRunPendingMethodByNodeId.value,
    [nodeId]: request.methodName,
  };
  directRunPendingModeByNodeId.value = {
    ...directRunPendingModeByNodeId.value,
    [nodeId]: mode,
  };
  clearDirectRunError(nodeId);

  try {
    if (!props.directRunUrl) {
      throw new Error("Direct run endpoint is unavailable for this graph URL.");
    }
    const response = await $fetch<DirectRunResultPayload>(props.directRunUrl, {
      method: "POST",
      body: buildDirectRunRequest(request),
    });
    const snapshot = buildDirectRunSnapshot({
      response,
      requestedMethod: request.methodName,
    });
    applyDirectRunResult({
      moduleName: request.moduleName,
      providerName: request.providerName,
      snapshot,
    });
    if (mode === "inspect" && snapshot.runtimeTrace) {
      emit("executionSequenceOpen");
    }
    clearDirectRunPending(nodeId);
  } catch (err) {
    clearDirectRunPending(nodeId);
    const errorPayload = err as {
      data?: DirectRunResultPayload;
      message?: string;
    };
    const responsePayload = errorPayload?.data;
    setDirectRunError(
      nodeId,
      responsePayload?.error ||
        (err instanceof Error ? err.message : "Direct run failed."),
    );
    if (responsePayload) {
      const snapshot = buildDirectRunSnapshot({
        response: responsePayload,
        requestedMethod: request.methodName,
      });
      applyDirectRunResult({
        moduleName: request.moduleName,
        providerName: request.providerName,
        snapshot,
      });
      if (mode === "inspect" && snapshot.runtimeTrace) {
        emit("executionSequenceOpen");
      }
    }
  }
}

function getDirectRunResultType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function getRuntimeTraceErrorName(
  trace: NonNullable<DirectRunExecutionSnapshot["runtimeTrace"]>,
): string {
  const failedSpan = trace.spans.find(
    (span) => span.spanId === trace.failedSpanId,
  );
  return failedSpan?.errorName || "Error";
}

function getProviderNodeId(moduleName: string, providerName: string): string {
  return `provider-${moduleName}-${providerName}`;
}

function applyDirectRunResult(payload: {
  moduleName: string;
  providerName: string;
  snapshot: DirectRunExecutionSnapshot;
}): void {
  const nodeId = getProviderNodeId(payload.moduleName, payload.providerName);
  directRunStateByNodeId.value = {
    ...directRunStateByNodeId.value,
    [nodeId]: payload.snapshot,
  };
  clearDirectRunPending(nodeId);
  clearDirectRunError(nodeId);
}

function requestDirectRun(
  method: DirectRunProviderMethod,
  mode: DirectRunMode,
): void {
  const context = selectedProviderContext.value;
  if (!context) {
    return;
  }

  const parsedArgs = parseDirectRunArgs(
    method,
    getDirectRunArgsInput(method.name),
  );
  if (!parsedArgs.ok) {
    setDirectRunArgsError(context.nodeId, method.name, parsedArgs.error);
    return;
  }

  clearDirectRunArgsError(context.nodeId, method.name);
  void executeDirectRun(
    {
      moduleName: context.moduleName,
      providerName: context.provider.name,
      methodName: method.name,
      args: parsedArgs.args,
    },
    mode,
  );
}

watch(
  () => ({
    nodeId: selectedProviderContext.value?.nodeId || "",
    tabs: directRunMethodTabs.value.map((tab) => tab.value),
  }),
  ({ tabs }) => {
    if (tabs.length === 0) {
      directRunActiveTab.value = "";
      return;
    }

    if (!tabs.includes(directRunActiveTab.value)) {
      directRunActiveTab.value = tabs[0] || "";
    }
  },
  { immediate: true },
);

function openCircularTooltip(edgeId: string): void {
  activeCircularTooltipEdgeId.value = edgeId;
}

function closeCircularTooltip(edgeId: string): void {
  if (activeCircularTooltipEdgeId.value === edgeId) {
    activeCircularTooltipEdgeId.value = null;
  }
}

function openCircularDetailDialog(edgeData: CircularEdgeData): void {
  circularDetailDialogData.value = {
    circularIds: [...edgeData.circularIds],
    issues: edgeData.circularDetails.map((detail) => ({
      id: detail.id,
      category: detail.category,
      type: detail.type,
      from: detail.from,
      to: detail.to,
      path: [...detail.path],
    })),
  };
  showCircularDetailDialog.value = true;
}

function rememberCurrentNodePositions(): void {
  for (const node of flowNodes.value) {
    nodePositionOverrides.set(node.id, {
      x: node.position.x,
      y: node.position.y,
    });
  }
}

function refreshGraph(options: { preservePositions?: boolean } = {}) {
  const preservePositions = options.preservePositions ?? true;
  if (preservePositions) {
    rememberCurrentNodePositions();
  } else {
    nodePositionOverrides.clear();
  }

  activeCircularTooltipEdgeId.value = null;
  activeBrightLineNodeId.value = null;
  if (
    selectedProviderNodeId.value &&
    !flowNodes.value.some((node) => node.id === selectedProviderNodeId.value)
  ) {
    selectedProviderNodeId.value = null;
  }
  showCircularDetailDialog.value = false;
  circularDetailDialogData.value = null;
  const graph = buildGraph(graphData.value, collapsedModuleNames.value, {
    showCircularDependencies: showCircularDependencies.value,
    showModuleToModuleLine: showModuleToModuleLine.value,
    showProviderToProviderInsideModule:
      showProviderToProviderInsideModule.value,
    showProviderToProviderAcrossModule:
      showProviderToProviderAcrossModule.value,
    nodePositions: preservePositions ? nodePositionOverrides : undefined,
  });
  flowNodes.value = graph.nodes;
  flowEdges.value = graph.edges;
  syncFixedBrightLineNode();
}

function toggleModule(moduleName: string) {
  const mod = graphData.value.modules[moduleName];
  if (!mod || !hasModuleComponents(mod)) {
    return;
  }

  const nextCollapsedModules = new Set(collapsedModuleNames.value);
  if (nextCollapsedModules.has(moduleName)) {
    nextCollapsedModules.delete(moduleName);
  } else {
    nextCollapsedModules.add(moduleName);
  }

  collapsedModuleNames.value = nextCollapsedModules;
  refreshGraph({ preservePositions: !autoAdjustGraphView.value });
  if (autoAdjustGraphView.value) {
    void centerGraph();
  }
}

function setAllModulesOpen(isOpen: boolean | "indeterminate") {
  collapsedModuleNames.value =
    isOpen === true
      ? getPermanentCollapsedModuleNames(graphData.value)
      : getDefaultCollapsedModuleNames(graphData.value);
  refreshGraph({ preservePositions: !autoAdjustGraphView.value });
  if (autoAdjustGraphView.value) {
    void centerGraph();
  }
}

watch(showCircularDependencies, () => {
  refreshGraph();
});

watch(showBrightLine, (isEnabled) => {
  if (!isEnabled) {
    activeBrightLineNodeId.value = null;
    return;
  }

  syncFixedBrightLineNode();
});

watch(
  () => props.enableBrightLine,
  (isEnabled) => {
    showBrightLine.value = isEnabled;
    if (!isEnabled) {
      activeBrightLineNodeId.value = null;
    }
  },
);

watch(
  fixedBrightLineTarget,
  (target) => {
    if (target) {
      syncFixedBrightLineNode();
      return;
    }

    activeBrightLineNodeId.value = null;
  },
  { immediate: true },
);

watch(showModuleToModuleLine, () => {
  refreshGraph();
});

watch(showProviderToProviderInsideModule, () => {
  refreshGraph();
});

watch(showProviderToProviderAcrossModule, () => {
  refreshGraph();
});

watch(
  graphData,
  () => {
    nodePositionOverrides.clear();
    collapsedModuleNames.value = getInitialCollapsedModuleNames(
      graphData.value,
    );
    refreshGraph({ preservePositions: false });
    syncDirectRunOn();
    void centerGraph();
  },
  { deep: true },
);

watch(() => props.directRunOn, syncDirectRunOn, { immediate: true });

watch(
  [() => props.defaultOpenModuleDetail, () => props.collapsedModules],
  () => {
    nodePositionOverrides.clear();
    collapsedModuleNames.value = getInitialCollapsedModuleNames(
      graphData.value,
    );
    refreshGraph({ preservePositions: false });
    void centerGraph();
  },
);

onMounted(() => {
  syncDirectRunOn();
  setTimeout(() => {
    void centerGraph(0);
  }, 200);
});

useResizeObserver(graphViewerRef, () => {
  debouncedCenterGraph();
});
</script>

<template>
  <div
    ref="graphViewerRef"
    class="graph-viewer"
    :class="{ 'graph-viewer--flush': props.flush }"
    :style="{ height: props.height }"
  >
    <div v-if="props.interactive" class="graph-viewer-settings">
      <UPopover
        v-model:open="showGraphSettings"
        :content="{ side: 'left', align: 'start', sideOffset: 8 }"
        arrow
      >
        <UButton
          type="button"
          icon="i-lucide-settings"
          color="neutral"
          variant="soft"
          square
          class="graph-viewer-settings__trigger nodrag nopan"
          aria-label="Graph settings"
          title="Graph settings"
        />

        <template #content>
          <div class="graph-viewer-settings__content nodrag nopan">
            <p class="graph-viewer-settings__title">Graph settings</p>
            <UCheckbox
              :model-value="allModulesOpenState"
              label="Open Module Detail"
              @update:model-value="setAllModulesOpen"
            />
            <UCheckbox v-model="autoAdjustGraphView" label="Auto Re-position" />
            <UCheckbox v-model="showLegends" label="Show Legends" />
            <div
              v-if="props.enableBrightLine"
              class="graph-viewer-settings__row"
            >
              <UCheckbox v-model="showBrightLine" label="Bright Line" />
              <UTooltip
                text="Highlight the full path of modules, providers, or controllers that depend on the hovered item."
                :delay-duration="0"
              >
                <UButton
                  type="button"
                  icon="i-lucide-circle-help"
                  color="neutral"
                  variant="ghost"
                  square
                  class="graph-viewer-settings__help"
                  aria-label="Bright Line help"
                />
              </UTooltip>
            </div>
            <UCheckbox
              v-model="showModuleToModuleLine"
              label="Show module to module line"
            />
            <UCheckbox
              v-model="showProviderToProviderInsideModule"
              label="Show provider to provider inside module"
            />
            <UCheckbox
              v-model="showProviderToProviderAcrossModule"
              label="Show provider to provider across module"
            />
            <UCheckbox
              v-model="showCircularDependencies"
              label="Circular dependencies"
            />
          </div>
        </template>
      </UPopover>
    </div>

    <div
      v-if="showLegends"
      class="graph-viewer-legends nodrag nopan"
      aria-label="Graph legends"
    >
      <p class="graph-viewer-legends__title">Legends</p>
      <div class="graph-viewer-legends__item">
        <span
          class="graph-viewer-legends__badge graph-viewer-legends__badge--provider"
        >
          P
        </span>
        <span class="graph-viewer-legends__label">Provider</span>
      </div>
      <div class="graph-viewer-legends__item">
        <span
          class="graph-viewer-legends__badge graph-viewer-legends__badge--export"
        >
          E
        </span>
        <span class="graph-viewer-legends__label">Exported</span>
      </div>
      <div class="graph-viewer-legends__item">
        <span
          class="graph-viewer-legends__badge graph-viewer-legends__badge--controller"
        >
          C
        </span>
        <span class="graph-viewer-legends__label">Controller</span>
      </div>
    </div>

    <VueFlow
      :id="flowId"
      v-model:nodes="flowNodes"
      v-model:edges="flowEdges"
      :default-viewport="{ zoom: 0.8, x: 0, y: 0 }"
      :min-zoom="0.05"
      :max-zoom="2"
      fit-view-on-init
      :fit-view-on-init-options="{ padding: GRAPH_FIT_PADDING }"
      :nodes-draggable="props.interactive"
      :nodes-connectable="props.interactive"
      :elements-selectable="props.interactive"
      :pan-on-drag="props.interactive"
      :pan-on-scroll="props.interactive"
      :zoom-on-scroll="props.interactive"
      :zoom-on-pinch="props.interactive"
      :zoom-on-double-click="props.interactive"
      class="graph-flow"
      @node-mouse-enter="setActiveBrightLineNode"
      @node-mouse-leave="clearActiveBrightLineNode"
      @node-click="handleNodeClick"
      @pane-click="selectProviderNode(null)"
    >
      <template #edge-warning="edgeProps">
        <BaseEdge
          :id="edgeProps.id"
          :path="getWarningEdgePath(edgeProps)"
          :marker-end="edgeProps.markerEnd"
          :style="edgeProps.style"
          :interaction-width="edgeProps.interactionWidth"
        />

        <EdgeLabelRenderer
          v-if="
            shouldShowCircularEdgeWarning(
              edgeProps.source,
              edgeProps.target,
              edgeProps.data,
            )
          "
        >
          <UTooltip
            :open="activeCircularTooltipEdgeId === edgeProps.id"
            :delay-duration="0"
            text="click for detail"
            @update:open="
              (isOpen) =>
                isOpen
                  ? openCircularTooltip(edgeProps.id)
                  : closeCircularTooltip(edgeProps.id)
            "
          >
            <div
              class="circular-edge-warning nodrag nopan"
              :style="getWarningEdgeLabelStyle(edgeProps)"
              role="button"
              :aria-label="edgeProps.data.circularReason"
              tabindex="0"
              @mouseenter="openCircularTooltip(edgeProps.id)"
              @mouseleave="closeCircularTooltip(edgeProps.id)"
              @click.stop="openCircularDetailDialog(edgeProps.data)"
              @keydown.enter.prevent="openCircularDetailDialog(edgeProps.data)"
              @keydown.space.prevent="openCircularDetailDialog(edgeProps.data)"
            >
              <UIcon
                name="i-lucide-triangle-alert"
                class="circular-edge-warning__icon"
              />
              <span class="circular-edge-warning__id">
                {{ edgeProps.data.circularIds.length }}
              </span>
            </div>
          </UTooltip>
        </EdgeLabelRenderer>
      </template>

      <template #node-module="moduleProps">
        <NodeResizer
          :is-visible="props.interactive && !moduleProps.data.isCollapsed"
          :min-width="moduleProps.data.minWidth"
          :min-height="moduleProps.data.minHeight"
          color="var(--mg-node-resizer-color)"
        />

        <Handle id="target-top" type="target" :position="Position.Top" />
        <Handle id="target-bottom" type="target" :position="Position.Bottom" />
        <Handle id="target-left" type="target" :position="Position.Left" />
        <Handle id="target-right" type="target" :position="Position.Right" />

        <div
          class="module-subgraph"
          :class="{
            'module-subgraph--root': moduleProps.data.isRoot,
            'module-subgraph--collapsed': moduleProps.data.isCollapsed,
            'module-subgraph--expandable': moduleProps.data.isExpandable,
          }"
        >
          <div class="module-subgraph__title">
            <span class="module-subgraph__label">
              {{ moduleProps.data.label }}
            </span>
            <button
              v-if="moduleProps.data.isExpandable"
              type="button"
              class="module-subgraph__toggle"
              :aria-expanded="!moduleProps.data.isCollapsed"
              :aria-label="
                moduleProps.data.isCollapsed
                  ? `Open ${moduleProps.data.label}`
                  : `Close ${moduleProps.data.label}`
              "
              @click.stop="toggleModule(moduleProps.data.label)"
            >
              <UIcon
                :name="
                  moduleProps.data.isCollapsed
                    ? 'i-lucide-plus'
                    : 'i-lucide-minus'
                "
                class="module-subgraph__toggle-icon"
              />
            </button>
          </div>
          <div
            v-if="!moduleProps.data.isCollapsed"
            class="module-subgraph__body"
          />
        </div>

        <Handle id="source-top" type="source" :position="Position.Top" />
        <Handle id="source-bottom" type="source" :position="Position.Bottom" />
        <Handle id="source-left" type="source" :position="Position.Left" />
        <Handle id="source-right" type="source" :position="Position.Right" />
      </template>

      <template #node-item="itemProps">
        <Handle id="target-top" type="target" :position="Position.Top" />
        <Handle id="target-bottom" type="target" :position="Position.Bottom" />
        <Handle id="target-left" type="target" :position="Position.Left" />
        <Handle id="target-right" type="target" :position="Position.Right" />

        <div
          class="mermaid-node"
          :class="`mermaid-node--${itemProps.data.kind}`"
        >
          <span class="mermaid-node__kind">
            {{ itemProps.data.kind === "controller" ? "C" : "P" }}
          </span>
          <span v-if="itemProps.data.isExported" class="mermaid-node__export">
            E
          </span>
          <span class="mermaid-node__label">
            {{ itemProps.data.label }}
          </span>
        </div>

        <Handle id="source-top" type="source" :position="Position.Top" />
        <Handle id="source-bottom" type="source" :position="Position.Bottom" />
        <Handle id="source-left" type="source" :position="Position.Left" />
        <Handle id="source-right" type="source" :position="Position.Right" />
      </template>

      <Background />
      <Controls v-if="props.interactive && props.showControls" />
      <MiniMap v-if="props.interactive && props.showMiniMap" />
    </VueFlow>

    <UDrawer
      v-model:open="showDirectRunDrawer"
      direction="right"
      :ui="{ content: 'w-screen max-w-md' }"
    >
      <template #header>
        <div class="direct-run-drawer__header">
          <div class="min-w-0">
            <p class="direct-run-drawer__eyebrow">Provider Action</p>
            <p class="direct-run-drawer__title">
              {{ selectedProviderContext?.provider.name }}
            </p>
            <p class="direct-run-drawer__subtitle">
              {{ selectedProviderContext?.moduleName }}
            </p>
          </div>

          <div class="direct-run-drawer__header-actions">
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              square
              aria-label="Close direct run drawer"
              @click="showDirectRunDrawer = false"
            />
          </div>
        </div>
      </template>

      <template #body>
        <div class="direct-run-drawer__body">
          <p
            v-if="
              selectedProviderDirectRunState &&
              !selectedProviderDirectRunState.runnable
            "
            class="direct-run-drawer__message"
          >
            {{ selectedProviderDirectRunState.reason }}
          </p>

          <UTabs
            v-else-if="directRunMethodTabs.length"
            v-model="directRunActiveTab"
            :items="directRunMethodTabs"
            color="primary"
            variant="pill"
            :ui="{
              root: 'gap-4',
              list: 'w-full overflow-x-auto',
              trigger: 'shrink-0',
              content: 'outline-none',
            }"
          >
            <template #content="{ item }">
              <div class="direct-run-drawer__method">
                <div class="direct-run-drawer__method-header">
                  <div class="min-w-0">
                    <p class="direct-run-drawer__method-name">
                      {{ getDirectRunMethodSignature(item.method) }}
                    </p>
                    <p
                      v-if="getDirectRunParameterCount(item.method)"
                      class="direct-run-drawer__method-subtitle"
                    >
                      JSON arguments
                    </p>
                  </div>
                  <UBadge
                    v-if="getDirectRunParameterCount(item.method)"
                    :label="`${getDirectRunParameterCount(item.method)} ${getDirectRunParameterCount(item.method) === 1 ? 'arg' : 'args'}`"
                    color="neutral"
                    variant="soft"
                  />
                </div>

                <ClientOnly v-if="getDirectRunParameterCount(item.method)">
                  <JsonMonacoEditor
                    :model-value="getDirectRunArgsInput(item.method.name)"
                    :path="getDirectRunEditorPath(item.method.name)"
                    :schema="getDirectRunArgsSchema(item.method)"
                    :readonly="Boolean(selectedProviderPendingMethod)"
                    height="240px"
                    @update:model-value="
                      (value) => setDirectRunArgsInput(item.method.name, value)
                    "
                    @validate="
                      (markers) =>
                        setDirectRunArgsValidation(item.method.name, markers)
                    "
                  />

                  <template #fallback>
                    <div class="direct-run-drawer__editor-placeholder">
                      Loading editor...
                    </div>
                  </template>
                </ClientOnly>

                <p
                  v-if="getDirectRunArgsError(item.method)"
                  class="direct-run-drawer__message direct-run-drawer__message--error"
                >
                  {{ getDirectRunArgsError(item.method) }}
                </p>

                <div class="direct-run-drawer__actions">
                  <p class="direct-run-drawer__action-label">
                    Direct Run this with
                  </p>
                  <div class="direct-run-drawer__action-buttons">
                    <UButton
                      type="button"
                      label="Run"
                      icon="i-lucide-play"
                      color="primary"
                      class="flex-1"
                      :loading="
                        selectedProviderPendingMethod === item.method.name &&
                        selectedProviderPendingMode === 'run'
                      "
                      :disabled="isDirectRunActionDisabled(item.method)"
                      @click="handleDirectRunAction(item.method, 'run')"
                    />
                    <UButton
                      type="button"
                      label="Run Inspection"
                      icon="i-lucide-chart-gantt"
                      color="neutral"
                      variant="soft"
                      class="flex-1"
                      :loading="
                        selectedProviderPendingMethod === item.method.name &&
                        selectedProviderPendingMode === 'inspect'
                      "
                      :disabled="isDirectRunActionDisabled(item.method)"
                      @click="handleDirectRunAction(item.method, 'inspect')"
                    />
                  </div>
                </div>
              </div>
            </template>
          </UTabs>

          <p
            v-if="selectedProviderPendingMethod"
            class="direct-run-drawer__message"
          >
            Running {{ selectedProviderPendingMethod }}()...
          </p>

          <p
            v-else-if="selectedProviderError"
            class="direct-run-drawer__message direct-run-drawer__message--error"
          >
            {{ selectedProviderError }}
          </p>

          <div
            v-if="selectedProviderSnapshot"
            class="direct-run-drawer__result"
          >
            <p class="direct-run-drawer__result-title">
              Last run · {{ selectedProviderSnapshot.method }}()
            </p>
            <p class="direct-run-drawer__message">
              {{ selectedProviderSnapshot.summary }}
            </p>
            <p
              v-if="selectedProviderLastRunLabel"
              class="direct-run-drawer__timestamp"
            >
              {{ selectedProviderLastRunLabel }}
            </p>
          </div>
        </div>
      </template>
    </UDrawer>

    <UModal
      v-model:open="showStaticDirectRunDialog"
      title="Direct Run is unavailable"
      description="This preview uses a static graph, so provider methods cannot run here. Open the saved execution history to explore a recorded run."
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            label="Cancel"
            color="neutral"
            variant="outline"
            @click="showStaticDirectRunDialog = false"
          />
          <UButton
            label="Open Execution Sequence"
            icon="i-lucide-history"
            color="primary"
            @click="openExecutionSequenceHistory"
          />
        </div>
      </template>
    </UModal>

    <UDrawer
      v-model:open="showCircularDetailDialog"
      side="right"
      :ui="{ content: 'w-screen max-w-none' }"
    >
      <template #header>
        <div class="flex w-full items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-base font-semibold text-highlighted">
              Circular Story
            </p>
          </div>

          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            square
            aria-label="Close drawer"
            @click="showCircularDetailDialog = false"
          />
        </div>
      </template>

      <template #body>
        <div class="circular-detail-dialog">
          <CircularDependencyIssueCard
            v-for="issue in circularDetailDialogData?.issues || []"
            :key="issue.id"
            :issue="issue"
            :flow="buildCircularIssueFlow(issue)"
            :flow-id="`circular-issue-dialog-${issue.id}`"
          />
        </div>
      </template>

      <template #footer>
        <div class="circular-detail-dialog__footer">
          <UButton
            label="Close"
            color="neutral"
            variant="outline"
            @click="showCircularDetailDialog = false"
          />
        </div>
      </template>
    </UDrawer>
  </div>
</template>

<style>
@import "@vue-flow/core/dist/style.css";
@import "@vue-flow/core/dist/theme-default.css";
@import "@vue-flow/controls/dist/style.css";
@import "@vue-flow/minimap/dist/style.css";
@import "@vue-flow/node-resizer/dist/style.css";

:root {
  --mg-node-bg: #ececff;
  --mg-node-border: #9370db;
  --mg-node-text: #333;
  --mg-controller-bg: #eaf7ff;
  --mg-controller-border: #38bdf8;
  --mg-controller-kind-bg: #0284c7;
  --mg-provider-bg: #ecfdf3;
  --mg-provider-border: #22c55e;
  --mg-provider-kind-bg: #16a34a;
  --mg-export-badge-bg: #d97706;
  --mg-subgraph-bg: rgba(236, 236, 255, 0.12);
  --mg-subgraph-border: #bbb;
  --mg-subgraph-title-bg: rgba(0, 0, 0, 0.04);
  --mg-subgraph-title-border: rgba(0, 0, 0, 0.08);
  --mg-root-border: #ff6b6b;
  --mg-root-bg: rgba(255, 107, 107, 0.06);
  --mg-root-title-bg: rgba(255, 107, 107, 0.08);
  --mg-node-resizer-color: #9370db;
  --mg-toggle-bg: var(--ui-secondary);
  --mg-toggle-bg-hover: color-mix(
    in srgb,
    var(--ui-secondary) 88%,
    var(--ui-text-highlighted)
  );
  --mg-toggle-text: var(--ui-bg);
  --mg-trace-border: rgba(148, 163, 184, 0.35);
  --mg-trace-bg: rgba(15, 23, 42, 0.04);
  --mg-trace-card-bg: rgba(15, 23, 42, 0.03);
  --mg-trace-error-border: rgba(239, 68, 68, 0.45);
  --mg-trace-slow-border: rgba(245, 158, 11, 0.45);
}

.dark {
  --mg-node-bg: #2d3748;
  --mg-node-border: #7c3aed;
  --mg-node-text: #e2e8f0;
  --mg-controller-bg: rgba(14, 116, 144, 0.26);
  --mg-controller-border: #22d3ee;
  --mg-controller-kind-bg: #0891b2;
  --mg-provider-bg: rgba(21, 128, 61, 0.26);
  --mg-provider-border: #4ade80;
  --mg-provider-kind-bg: #16a34a;
  --mg-export-badge-bg: #f59e0b;
  --mg-subgraph-bg: rgba(255, 255, 255, 0.04);
  --mg-subgraph-border: #4a5568;
  --mg-subgraph-title-bg: rgba(255, 255, 255, 0.06);
  --mg-subgraph-title-border: rgba(255, 255, 255, 0.08);
  --mg-root-border: #f87171;
  --mg-root-bg: rgba(248, 113, 113, 0.08);
  --mg-root-title-bg: rgba(248, 113, 113, 0.1);
  --mg-node-resizer-color: #a78bfa;
  --mg-trace-border: rgba(148, 163, 184, 0.4);
  --mg-trace-bg: rgba(15, 23, 42, 0.36);
  --mg-trace-card-bg: rgba(15, 23, 42, 0.48);
  --mg-trace-error-border: rgba(248, 113, 113, 0.55);
  --mg-trace-slow-border: rgba(251, 191, 36, 0.55);
}

.graph-viewer {
  width: 100%;
  position: relative;
  border-radius: 0.75rem;
  overflow: hidden;
  border: 1px solid var(--mg-subgraph-border);
}

.graph-viewer--flush {
  border: 0;
  border-radius: 0;
}

.graph-viewer-settings {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
}

.graph-viewer .vue-flow__edge-labels {
  z-index: 7;
  pointer-events: none;
}

.graph-viewer-settings__trigger {
  width: 34px;
  height: 34px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.22);
}

.graph-viewer-settings__content {
  width: 240px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-family: "Public Sans", system-ui, sans-serif;
}

.graph-viewer-settings__title {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.2;
}

.graph-viewer-settings__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.graph-viewer-settings__help {
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
}

.graph-viewer-legends {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 10;
  min-width: 178px;
  padding: 10px;
  border: 1px solid var(--mg-subgraph-title-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ui-bg) 94%, transparent);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-family: "Public Sans", system-ui, sans-serif;
  pointer-events: none;
}

.direct-run-drawer__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.direct-run-drawer__header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.direct-run-drawer__body,
.direct-run-drawer__method,
.direct-run-drawer__result {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.direct-run-drawer__eyebrow,
.direct-run-drawer__method-name,
.direct-run-drawer__method-subtitle,
.direct-run-drawer__subtitle,
.direct-run-drawer__timestamp,
.direct-run-drawer__message,
.direct-run-drawer__result-title,
.direct-run-drawer__title {
  margin: 0;
}

.direct-run-drawer__eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ui-text-muted);
}

.direct-run-drawer__title {
  font-size: 14px;
  font-weight: 700;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}

.direct-run-drawer__subtitle,
.direct-run-drawer__method-subtitle,
.direct-run-drawer__timestamp {
  font-size: 12px;
  color: var(--ui-text-muted);
}

.direct-run-drawer__method-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.direct-run-drawer__actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.direct-run-drawer__action-label {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
}

.direct-run-drawer__action-buttons {
  display: flex;
  gap: 8px;
}

.direct-run-drawer__method-name {
  min-width: 0;
  color: var(--ui-text-highlighted);
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
    monospace;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.direct-run-drawer__editor-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  color: var(--ui-text-muted);
  font-size: 13px;
}

.direct-run-drawer__message {
  font-size: 13px;
  line-height: 1.45;
  color: var(--ui-text);
  overflow-wrap: anywhere;
}

.direct-run-drawer__message--error {
  color: var(--ui-error);
}

.direct-run-drawer__result {
  width: 100%;
}

.direct-run-drawer__result-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}

.graph-viewer-legends__title {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.2;
}

.graph-viewer-legends__item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.graph-viewer-legends__badge {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 18px;
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 10px;
  font-weight: 700;
}

.graph-viewer-legends__badge--provider {
  background: var(--mg-provider-kind-bg);
}

.graph-viewer-legends__badge--export {
  background: var(--mg-export-badge-bg);
}

.graph-viewer-legends__badge--controller {
  background: var(--mg-controller-kind-bg);
}

.graph-viewer-legends__label {
  min-width: 0;
  color: var(--ui-text);
  font-size: 12px;
  line-height: 1.25;
}

.graph-viewer .vue-flow__node {
  transition:
    opacity 140ms ease,
    filter 140ms ease;
}

.graph-viewer .vue-flow__edge {
  transition: opacity 140ms ease;
}

.graph-viewer .vue-flow__edge-path {
  transition:
    stroke 140ms ease,
    stroke-width 140ms ease,
    filter 140ms ease;
}

.graph-viewer .bright-line-node--dimmed {
  opacity: 0.28;
  filter: saturate(0.55);
}

.graph-viewer .bright-line-node--active .module-subgraph,
.graph-viewer .bright-line-node--connected .module-subgraph,
.graph-viewer .bright-line-node--active .mermaid-node,
.graph-viewer .bright-line-node--connected .mermaid-node {
  border-color: var(--ui-primary) !important;
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--ui-primary) 34%, transparent),
    0 10px 26px rgba(15, 23, 42, 0.2);
}

.graph-viewer .bright-line-node--active .module-subgraph,
.graph-viewer .bright-line-node--active .mermaid-node {
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--ui-primary) 42%, transparent),
    0 12px 30px rgba(15, 23, 42, 0.24);
}

.graph-viewer .bright-line-node--fixed .module-subgraph,
.graph-viewer .bright-line-node--fixed .mermaid-node {
  outline: 2px dashed var(--ui-primary);
  outline-offset: 4px;
}

.graph-viewer .bright-line-edge {
  opacity: 1;
  z-index: 12;
}

.graph-viewer .bright-line-edge .vue-flow__edge-path {
  stroke: var(--ui-primary) !important;
  stroke-width: 3.2px !important;
  filter: drop-shadow(
    0 0 5px color-mix(in srgb, var(--ui-primary) 52%, transparent)
  );
}

.graph-viewer .bright-line-edge--dimmed {
  opacity: 0.16;
}

.graph-viewer .bright-line-edge--hidden {
  opacity: 0;
  pointer-events: none;
}

.module-subgraph {
  width: 100%;
  height: 100%;
  background: var(--mg-subgraph-bg);
  border: 2px solid var(--mg-subgraph-border);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  font-family: "Public Sans", system-ui, sans-serif;
  box-sizing: border-box;
}

.module-subgraph--root {
  border-color: var(--mg-root-border);
  background: var(--mg-root-bg);
}

.module-subgraph__title {
  font-weight: 700;
  font-size: 13px;
  padding: 4px 12px 4px 14px;
  background: var(--mg-subgraph-title-bg);
  border-bottom: 1px solid var(--mg-subgraph-title-border);
  border-radius: 6px 6px 0 0;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  box-sizing: border-box;
  user-select: none;
}

.module-subgraph--root .module-subgraph__title {
  background: var(--mg-root-title-bg);
}

.module-subgraph--collapsed .module-subgraph__title {
  flex: 1;
  border-bottom: 0;
  border-radius: 6px;
}

.module-subgraph__label {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.module-subgraph__toggle {
  width: 28px;
  height: 28px;
  border: 1px solid var(--mg-toggle-bg);
  border-radius: 4px;
  background: var(--mg-toggle-bg);
  color: var(--mg-toggle-text);
  box-shadow: 0 2px 8px rgba(76, 29, 149, 0.28);
  flex: 0 0 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
  cursor: pointer;
}

.module-subgraph__toggle:hover {
  border-color: var(--mg-toggle-bg-hover);
  background: var(--mg-toggle-bg-hover);
}

.module-subgraph__toggle:focus-visible {
  outline: 2px solid var(--mg-toggle-bg-hover);
  outline-offset: 2px;
}

.module-subgraph__toggle-icon {
  width: 18px;
  height: 18px;
}

.module-subgraph__body {
  flex: 1;
}

.mermaid-node {
  width: 100%;
  height: 100%;
  background: var(--mg-node-bg);
  border: 2px solid var(--mg-node-border);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 0 10px;
  font-size: 12px;
  font-family: ui-monospace, "SF Mono", monospace;
  color: var(--mg-node-text);
  box-sizing: border-box;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mermaid-node--controller {
  background: var(--mg-controller-bg);
  border-color: var(--mg-controller-border);
}

.mermaid-node--provider {
  background: var(--mg-provider-bg);
  border-color: var(--mg-provider-border);
}

.mermaid-node__kind {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 700;
}

.mermaid-node__export {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: var(--mg-export-badge-bg);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 700;
}

.mermaid-node--controller .mermaid-node__kind {
  background: var(--mg-controller-kind-bg);
}

.mermaid-node--provider .mermaid-node__kind {
  background: var(--mg-provider-kind-bg);
}

.mermaid-node__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.circular-edge-warning {
  min-width: 46px;
  height: 20px;
  padding: 0 7px;
  border: 1px solid #f59e0b;
  border-radius: 999px;
  background: #facc15;
  color: #713f12;
  box-shadow: 0 1px 4px rgba(120, 53, 15, 0.28);
  cursor: help;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 11px;
  font-weight: 900;
  line-height: 1;
  white-space: nowrap;
  user-select: none;
  pointer-events: all;
}

.circular-edge-warning__icon {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
}

.circular-edge-warning__id {
  display: inline-block;
}

.circular-detail-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.circular-detail-dialog__footer {
  width: 100%;
  display: flex;
  justify-content: flex-end;
}

.vue-flow__node-module {
  padding: 0 !important;
  border: none !important;
  background: none !important;
  box-shadow: none !important;
  border-radius: 0 !important;
}

.vue-flow__node-item {
  padding: 0 !important;
  border: none !important;
  background: none !important;
  box-shadow: none !important;
  border-radius: 0 !important;
}

.vue-flow__handle {
  width: 6px;
  height: 6px;
  min-width: 0;
  min-height: 0;
  opacity: 0;
  border: none;
}
</style>
