export type DirectRunProviderMethod = {
  name: string;
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
