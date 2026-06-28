export type DirectRunJsonSchema = Record<string, unknown>;

export type DirectRunProviderMethod = {
  name: string;
  parameterCount: number;
  parameterNames?: string[];
  parameterTypes?: string[];
  parameterSchemas?: DirectRunJsonSchema[];
};

export type DirectRunProviderMeta = {
  methods: DirectRunProviderMethod[];
};

export type DirectRunResult = {
  ok: boolean;
  method?: string;
  result?: unknown;
  error?: string;
};
