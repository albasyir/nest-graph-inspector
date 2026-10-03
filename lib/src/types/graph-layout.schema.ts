import type { GraphLayout } from './graph-layout.type';

export const GRAPH_LAYOUT_SCHEMA_VERSION = '1';

export const GRAPH_LAYOUT_SCHEMA_ID =
  'https://albasyir.github.io/nest-graph-inspector/schemas/graph-layout-v1.schema.json';

export const GRAPH_LAYOUT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: GRAPH_LAYOUT_SCHEMA_ID,
  title: 'Nest Graph Inspector Graph Layout',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'modules'],
  properties: {
    $schema: {
      type: 'string',
    },
    version: {
      const: GRAPH_LAYOUT_SCHEMA_VERSION,
    },
    modules: {
      type: 'object',
      propertyNames: {
        $ref: '#/$defs/key',
      },
      additionalProperties: {
        $ref: '#/$defs/module',
      },
    },
  },
  $defs: {
    key: {
      description:
        'A layout file is committed and shared, so a key a naive deep merge would follow into Object.prototype is refused.',
      not: {
        const: '__proto__',
      },
    },
    position: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: {
        x: {
          type: 'number',
        },
        y: {
          type: 'number',
        },
      },
    },
    module: {
      type: 'object',
      additionalProperties: false,
      required: ['position'],
      properties: {
        position: {
          $ref: '#/$defs/position',
        },
        isCollapsed: {
          type: 'boolean',
        },
        items: {
          type: 'object',
          propertyNames: {
            $ref: '#/$defs/key',
          },
          additionalProperties: {
            $ref: '#/$defs/position',
          },
        },
      },
    },
  },
} as const;

export type GraphLayoutValidationResult =
  | { ok: true; layout: GraphLayout }
  | { ok: false; errors: string[] };

/** One error is enough to reject a layout; a handful is enough to fix one. */
const MAX_REPORTED_ERRORS = 20;

type ObjectShape = {
  readonly required: readonly string[];
  readonly properties: object;
};

type Report = (pointer: string, problem: string) => void;

/**
 * Checks a value against `GRAPH_LAYOUT_JSON_SCHEMA` without a schema engine,
 * since the package ships no runtime dependency beyond ts-morph. Required and
 * allowed property names are read from the schema itself, so the two cannot
 * drift apart on shape.
 *
 * Coordinates must also be finite: `JSON.parse('1e999')` is `Infinity`, which
 * `JSON.stringify` would write back as `null`.
 *
 * Each error names a JSON Pointer rooted at `layout`, such as
 * `layout/modules/UserModule/position/x must be a finite number`. At most 20
 * errors are reported.
 */
export function validateGraphLayout(
  value: unknown,
): GraphLayoutValidationResult {
  const errors: string[] = [];
  const report: Report = (pointer, problem) => {
    if (errors.length < MAX_REPORTED_ERRORS) {
      errors.push(`${pointer} ${problem}`);
    }
  };

  validateRoot(value, report);

  return errors.length
    ? { ok: false, errors }
    : { ok: true, layout: value as GraphLayout };
}

function validateRoot(value: unknown, report: Report): void {
  const pointer = 'layout';
  if (!isObject(value)) {
    report(pointer, 'must be a JSON object');
    return;
  }

  checkShape(value, pointer, GRAPH_LAYOUT_JSON_SCHEMA, report);

  if (Object.hasOwn(value, '$schema') && typeof value.$schema !== 'string') {
    report(childPointer(pointer, '$schema'), 'must be a string');
  }

  if (
    Object.hasOwn(value, 'version') &&
    value.version !== GRAPH_LAYOUT_SCHEMA_VERSION
  ) {
    report(
      childPointer(pointer, 'version'),
      `must be "${GRAPH_LAYOUT_SCHEMA_VERSION}"`,
    );
  }

  if (Object.hasOwn(value, 'modules')) {
    validateRecord(
      value.modules,
      childPointer(pointer, 'modules'),
      validateModule,
      report,
    );
  }
}

function validateModule(value: unknown, pointer: string, report: Report): void {
  if (!isObject(value)) {
    report(pointer, 'must be an object');
    return;
  }

  checkShape(value, pointer, GRAPH_LAYOUT_JSON_SCHEMA.$defs.module, report);

  if (Object.hasOwn(value, 'position')) {
    validatePosition(value.position, childPointer(pointer, 'position'), report);
  }

  if (
    Object.hasOwn(value, 'isCollapsed') &&
    typeof value.isCollapsed !== 'boolean'
  ) {
    report(childPointer(pointer, 'isCollapsed'), 'must be a boolean');
  }

  if (Object.hasOwn(value, 'items')) {
    validateRecord(
      value.items,
      childPointer(pointer, 'items'),
      validatePosition,
      report,
    );
  }
}

function validatePosition(
  value: unknown,
  pointer: string,
  report: Report,
): void {
  if (!isObject(value)) {
    report(pointer, 'must be an object');
    return;
  }

  checkShape(value, pointer, GRAPH_LAYOUT_JSON_SCHEMA.$defs.position, report);

  for (const axis of GRAPH_LAYOUT_JSON_SCHEMA.$defs.position.required) {
    if (Object.hasOwn(value, axis) && !Number.isFinite(value[axis])) {
      report(childPointer(pointer, axis), 'must be a finite number');
    }
  }
}

function validateRecord(
  value: unknown,
  pointer: string,
  validateEntry: (entry: unknown, pointer: string, report: Report) => void,
  report: Report,
): void {
  if (!isObject(value)) {
    report(pointer, 'must be an object');
    return;
  }

  const forbiddenKey = GRAPH_LAYOUT_JSON_SCHEMA.$defs.key.not.const;
  for (const [key, entry] of Object.entries(value)) {
    if (key === forbiddenKey) {
      report(pointer, `must not contain the key "${forbiddenKey}"`);
      continue;
    }

    validateEntry(entry, childPointer(pointer, key), report);
  }
}

function checkShape(
  value: Record<string, unknown>,
  pointer: string,
  shape: ObjectShape,
  report: Report,
): void {
  for (const name of shape.required) {
    if (!Object.hasOwn(value, name)) {
      report(pointer, `is missing required property "${name}"`);
    }
  }

  for (const name of Object.keys(value)) {
    if (!Object.hasOwn(shape.properties, name)) {
      report(childPointer(pointer, name), 'is not a known property');
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 6901 escaping, so a key containing `/` cannot be misread as a path. */
function childPointer(pointer: string, key: string): string {
  return `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}
