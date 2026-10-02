import {
  GRAPH_LAYOUT_JSON_SCHEMA,
  GRAPH_LAYOUT_SCHEMA_ID,
  GRAPH_LAYOUT_SCHEMA_VERSION,
  validateGraphLayout,
} from './graph-layout.schema';
import type { GraphLayout } from './graph-layout.type';

/** The errors a rejected value produced, or a failure if it was accepted. */
function errorsFor(value: unknown): string[] {
  const result = validateGraphLayout(value);
  if (result.ok) {
    throw new Error(`Expected ${JSON.stringify(value)} to be rejected`);
  }

  return result.errors;
}

describe('graph layout schema', () => {
  const position = { x: 10, y: 20 };

  it('publishes a draft 2020-12 schema whose id and version constant agree', () => {
    expect(GRAPH_LAYOUT_SCHEMA_VERSION).toBe('1');
    expect(GRAPH_LAYOUT_JSON_SCHEMA.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(GRAPH_LAYOUT_JSON_SCHEMA.$id).toBe(GRAPH_LAYOUT_SCHEMA_ID);
    expect(GRAPH_LAYOUT_SCHEMA_ID).toContain(
      `graph-layout-v${GRAPH_LAYOUT_SCHEMA_VERSION}`,
    );
    expect(GRAPH_LAYOUT_JSON_SCHEMA.properties.version.const).toBe(
      GRAPH_LAYOUT_SCHEMA_VERSION,
    );
  });

  describe(validateGraphLayout.name, () => {
    it('accepts an empty layout', () => {
      const layout: GraphLayout = { version: '1', modules: {} };

      expect(validateGraphLayout(layout)).toEqual({ ok: true, layout });
    });

    it('accepts every optional field, and hands back the same object', () => {
      const layout: GraphLayout = {
        $schema: GRAPH_LAYOUT_SCHEMA_ID,
        version: '1',
        modules: {
          AppModule: { position: { x: 0, y: 0 } },
          UserModule: {
            position: { x: -120.5, y: 48 },
            isCollapsed: true,
            items: {
              'provider:UserService': { x: 16, y: 64 },
              'controller:UserController': { x: 216, y: 64 },
            },
          },
        },
      };

      const result = validateGraphLayout(layout);

      expect(result.ok).toBe(true);
      expect(result.ok && result.layout).toBe(layout);
    });

    it('accepts a layout parsed from its own serialization', () => {
      const layout: GraphLayout = {
        version: '1',
        modules: { UserModule: { position, items: { a: position } } },
      };

      expect(
        validateGraphLayout(JSON.parse(JSON.stringify(layout, null, 2))),
      ).toMatchObject({ ok: true });
    });

    it.each([
      ['null', null],
      ['an array', []],
      ['a string', '{"version":"1","modules":{}}'],
      ['a number', 1],
      ['undefined', undefined],
    ])('rejects %s as the layout', (_label, value) => {
      expect(errorsFor(value)).toEqual(['layout must be a JSON object']);
    });

    it('names every missing required property', () => {
      expect(errorsFor({})).toEqual([
        'layout is missing required property "version"',
        'layout is missing required property "modules"',
      ]);
    });

    it.each([['2'], [1], [null]])('rejects version %p', (version) => {
      expect(errorsFor({ version, modules: {} })).toEqual([
        'layout/version must be "1"',
      ]);
    });

    it('rejects a $schema that is not a string', () => {
      expect(errorsFor({ $schema: 1, version: '1', modules: {} })).toEqual([
        'layout/$schema must be a string',
      ]);
    });

    it.each([
      ['an array', []],
      ['null', null],
      ['a string', 'UserModule'],
    ])('rejects modules given as %s', (_label, modules) => {
      expect(errorsFor({ version: '1', modules })).toEqual([
        'layout/modules must be an object',
      ]);
    });

    it('rejects unknown properties at every level', () => {
      expect(
        errorsFor({
          version: '1',
          modules: {
            UserModule: {
              position: { x: 1, y: 2, z: 3 },
              colour: 'red',
              items: { a: { x: 1, y: 2, width: 10 } },
            },
          },
          viewport: { zoom: 1 },
        }),
      ).toEqual([
        'layout/viewport is not a known property',
        'layout/modules/UserModule/colour is not a known property',
        'layout/modules/UserModule/position/z is not a known property',
        'layout/modules/UserModule/items/a/width is not a known property',
      ]);
    });

    it('requires a position on every module', () => {
      expect(errorsFor({ version: '1', modules: { UserModule: {} } })).toEqual(
        ['layout/modules/UserModule is missing required property "position"'],
      );
    });

    it.each([
      ['a string', '10'],
      ['null', null],
      ['a boolean', true],
    ])('rejects a coordinate given as %s', (_label, x) => {
      expect(
        errorsFor({
          version: '1',
          modules: { UserModule: { position: { x, y: 0 } } },
        }),
      ).toEqual([
        'layout/modules/UserModule/position/x must be a finite number',
      ]);
    });

    it.each([
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['NaN', NaN],
    ])('rejects a non-finite coordinate (%s)', (_label, y) => {
      expect(
        errorsFor({
          version: '1',
          modules: { UserModule: { position: { x: 0, y } } },
        }),
      ).toEqual([
        'layout/modules/UserModule/position/y must be a finite number',
      ]);
    });

    it('rejects a coordinate JSON can spell but JavaScript cannot hold', () => {
      // 1e999 is a valid JSON number that parses to Infinity, which
      // JSON.stringify would write back as null.
      expect(
        errorsFor(
          JSON.parse(
            '{"version":"1","modules":{"UserModule":{"position":{"x":1e999,"y":0}}}}',
          ),
        ),
      ).toEqual([
        'layout/modules/UserModule/position/x must be a finite number',
      ]);
    });

    it('requires both coordinates of a position', () => {
      expect(
        errorsFor({
          version: '1',
          modules: { UserModule: { position: { x: 1 } } },
        }),
      ).toEqual([
        'layout/modules/UserModule/position is missing required property "y"',
      ]);
    });

    it('rejects an isCollapsed flag that is not a boolean', () => {
      expect(
        errorsFor({
          version: '1',
          modules: { UserModule: { position, isCollapsed: 'yes' } },
        }),
      ).toEqual(['layout/modules/UserModule/isCollapsed must be a boolean']);
    });

    it('rejects items that are not a record of positions', () => {
      expect(
        errorsFor({
          version: '1',
          modules: {
            ArrayItems: { position, items: [position] },
            BadItem: { position, items: { a: 'here' } },
          },
        }),
      ).toEqual([
        'layout/modules/ArrayItems/items must be an object',
        'layout/modules/BadItem/items/a must be an object',
      ]);
    });

    it('refuses a __proto__ key among modules or items', () => {
      // JSON.parse creates __proto__ as an own key, the way a request body or
      // a hand-edited file would carry it.
      expect(
        errorsFor(
          JSON.parse(
            '{"version":"1","modules":{"__proto__":{"position":{"x":0,"y":0}},"UserModule":{"position":{"x":0,"y":0},"items":{"__proto__":{"x":0,"y":0}}}}}',
          ),
        ),
      ).toEqual([
        'layout/modules must not contain the key "__proto__"',
        'layout/modules/UserModule/items must not contain the key "__proto__"',
      ]);
    });

    it('escapes keys in error paths so a "/" cannot be read as nesting', () => {
      expect(
        errorsFor({
          version: '1',
          modules: { UserModule: { position, items: { 'a/b~c': { x: 0 } } } },
        }),
      ).toEqual([
        'layout/modules/UserModule/items/a~1b~0c is missing required property "y"',
      ]);
    });

    it('stops reporting after twenty errors', () => {
      const modules = Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [`Module${index}`, {}]),
      );

      expect(errorsFor({ version: '1', modules })).toHaveLength(20);
    });
  });
});
