export type GraphOutputDependencyRef = {
  providedBy: { type: string; name: string };
  token: string;
};

import type { DirectRunProviderMeta } from './direct-run.type';

export type GraphOutputProvider = {
  name: string;
  jsdoc?: string;
  dependencies: GraphOutputDependencyRef[];
  directRun?: DirectRunProviderMeta;
};

export type GraphOutputController = {
  name: string;
  jsdoc?: string;
  dependencies: GraphOutputDependencyRef[];
};

export type GraphOutputModule = {
  jsdoc?: string;
  imports: string[];
  exports: string[];
  providers: GraphOutputProvider[];
  controllers: GraphOutputController[];
};

export type GraphOutputCycleType = 'direct' | 'indirect';

export type GraphOutputCycleBase = {
  id: number;
  from: string;
  to: string;
  type: GraphOutputCycleType;
};

export type GraphOutputCycle = GraphOutputCycleBase & {
  path: string[];
};

export type GraphOutputProviderCyclePathItem = {
  module: { name: string };
  provider: { name: string };
};

export type GraphOutputProviderCycle = GraphOutputCycleBase & {
  path: GraphOutputProviderCyclePathItem[];
};

export type GraphOutputCycles = {
  modules: GraphOutputCycle[];
  providers: GraphOutputProviderCycle[];
  controllers: GraphOutputCycle[];
};

export type GraphOutput = {
  version: string;
  root: string;
  modules: Record<string, GraphOutputModule>;
  cycles: GraphOutputCycles;
};
