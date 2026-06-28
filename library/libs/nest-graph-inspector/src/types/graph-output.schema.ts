export const GRAPH_OUTPUT_SCHEMA_VERSION = '3';

export const GRAPH_OUTPUT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://albasyir.github.io/nest-graph-inspector/schemas/graph-output-v3.schema.json',
  title: 'Nest Graph Inspector Graph Output',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'root', 'modules', 'cycles'],
  properties: {
    version: {
      const: GRAPH_OUTPUT_SCHEMA_VERSION,
    },
    root: {
      type: 'string',
    },
    modules: {
      type: 'object',
      additionalProperties: {
        $ref: '#/$defs/module',
      },
    },
    cycles: {
      $ref: '#/$defs/cycles',
    },
  },
  $defs: {
    dependencyRef: {
      type: 'object',
      additionalProperties: false,
      required: ['providedBy', 'token'],
      properties: {
        providedBy: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'name'],
          properties: {
            type: {
              type: 'string',
            },
            name: {
              type: 'string',
            },
          },
        },
        token: {
          type: 'string',
        },
      },
    },
    provider: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'dependencies'],
      properties: {
        name: {
          type: 'string',
        },
        jsdoc: {
          type: 'string',
        },
        dependencies: {
          type: 'array',
          items: {
            $ref: '#/$defs/dependencyRef',
          },
        },
        directRun: {
          $ref: '#/$defs/directRunProviderMeta',
        },
      },
    },
    directRunProviderMethod: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: {
          type: 'string',
        },
      },
    },
    directRunProviderMeta: {
      type: 'object',
      additionalProperties: false,
      required: ['methods'],
      properties: {
        methods: {
          type: 'array',
          items: {
            $ref: '#/$defs/directRunProviderMethod',
          },
        },
      },
    },
    controller: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'dependencies'],
      properties: {
        name: {
          type: 'string',
        },
        jsdoc: {
          type: 'string',
        },
        dependencies: {
          type: 'array',
          items: {
            $ref: '#/$defs/dependencyRef',
          },
        },
      },
    },
    module: {
      type: 'object',
      additionalProperties: false,
      required: ['imports', 'exports', 'providers', 'controllers'],
      properties: {
        jsdoc: {
          type: 'string',
        },
        imports: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        exports: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        providers: {
          type: 'array',
          items: {
            $ref: '#/$defs/provider',
          },
        },
        controllers: {
          type: 'array',
          items: {
            $ref: '#/$defs/controller',
          },
        },
      },
    },
    cycleType: {
      enum: ['direct', 'indirect'],
    },
    cycle: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'from', 'to', 'type', 'path'],
      properties: {
        id: {
          type: 'number',
        },
        from: {
          type: 'string',
        },
        to: {
          type: 'string',
        },
        type: {
          $ref: '#/$defs/cycleType',
        },
        path: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
    },
    providerCyclePathItem: {
      type: 'object',
      additionalProperties: false,
      required: ['module', 'provider'],
      properties: {
        module: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: {
              type: 'string',
            },
          },
        },
        provider: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: {
              type: 'string',
            },
          },
        },
      },
    },
    providerCycle: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'from', 'to', 'type', 'path'],
      properties: {
        id: {
          type: 'number',
        },
        from: {
          type: 'string',
        },
        to: {
          type: 'string',
        },
        type: {
          $ref: '#/$defs/cycleType',
        },
        path: {
          type: 'array',
          items: {
            $ref: '#/$defs/providerCyclePathItem',
          },
        },
      },
    },
    cycles: {
      type: 'object',
      additionalProperties: false,
      required: ['modules', 'providers', 'controllers'],
      properties: {
        modules: {
          type: 'array',
          items: {
            $ref: '#/$defs/cycle',
          },
        },
        providers: {
          type: 'array',
          items: {
            $ref: '#/$defs/providerCycle',
          },
        },
        controllers: {
          type: 'array',
          items: {
            $ref: '#/$defs/cycle',
          },
        },
      },
    },
  },
} as const;
