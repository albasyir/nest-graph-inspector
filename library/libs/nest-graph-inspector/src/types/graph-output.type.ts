export type GraphOutputDependencyRef = {
  providedBy: { type: string; name: string };
  token: string;
};

export type GraphOutputProvider = {
  name: string;
  dependencies: GraphOutputDependencyRef[];
};

export type GraphOutputController = {
  name: string;
  dependencies: GraphOutputDependencyRef[];
};

export type GraphOutputModule = {
  imports: string[];
  exports: string[];
  providers: GraphOutputProvider[];
  controllers: GraphOutputController[];
};

export type GraphOutput = {
  version: string;
  root: string;
  modules: Record<string, GraphOutputModule>;
};
