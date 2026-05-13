export type ProxyCorsOptions = {
  origins: Array<string | RegExp>;
  methods?: string[];
  allowHeaders?: string | string[];
  credentials?: boolean;
};

export type ProxyGatewayOptions = {
  from: string;
  to: string;
  cors?: ProxyCorsOptions | false;
};

export interface ProxyGateway {
  serve(options: ProxyGatewayOptions): Promise<void>;
  close(): void;
}
