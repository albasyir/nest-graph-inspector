import { GraphOutput } from '../types/graph-output.type';

export interface OutputAdapter<Config = unknown> {
  execute(
    graphOutput: GraphOutput,
    config: Config,
  ): Promise<{
    message: string;
  }>;
}
