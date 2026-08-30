import { strict as assert } from 'node:assert'
import {
  hasJsDocPreview,
  parseJsDocPreview,
  type JsDocPreviewBlock
} from './jsdoc-preview.ts'

// Nothing to show is the common case: most classes carry no comment at all, and
// the viewer must not open an empty card for them.
for (const empty of [undefined, null, '', '   ', '\n\n', 0, {}, []]) {
  assert.deepEqual(
    parseJsDocPreview(empty as string | null | undefined),
    [],
    `${JSON.stringify(empty)} should render no blocks`
  )
  assert.equal(hasJsDocPreview(empty as string | null | undefined), false)
}

assert.ok(hasJsDocPreview('UserModule is example feature'))

// A hard-wrapped paragraph is one paragraph: the author's line breaks were for
// their editor's width, not the card's.
assert.deepEqual(
  parseJsDocPreview(
    'This is playground root module\nthat imports the feature modules.'
  ),
  [
    {
      kind: 'paragraph',
      text: 'This is playground root module that imports the feature modules.'
    }
  ]
)

// A blank line is the only paragraph break.
assert.deepEqual(
  parseJsDocPreview('First paragraph.\n\nSecond paragraph.'),
  [
    { kind: 'paragraph', text: 'First paragraph.' },
    { kind: 'paragraph', text: 'Second paragraph.' }
  ]
)

// Bullets keep their own shape, and a wrapped bullet stays one item.
assert.deepEqual(
  parseJsDocPreview(
    [
      'Collects:',
      '- imported modules',
      '* exported providers',
      '  spanning two lines',
      '+ registered controllers'
    ].join('\n')
  ),
  [
    { kind: 'paragraph', text: 'Collects:' },
    {
      kind: 'list',
      items: [
        'imported modules',
        'exported providers spanning two lines',
        'registered controllers'
      ]
    }
  ] satisfies JsDocPreviewBlock[]
)

// `{@link}` has nowhere to navigate to in the viewer, so it renders as text:
// its label when it has one, otherwise its target.
assert.deepEqual(
  parseJsDocPreview(
    'Resolved with {@link forwardRef}, see {@link OrderService|the service} '
    + 'and {@linkplain UserModule the user module}.'
  ),
  [
    {
      kind: 'paragraph',
      text:
        'Resolved with forwardRef, see the service and the user module.'
    }
  ]
)

// A list written entirely with `*` bullets is a list, not a comment gutter.
// Nothing but the delimiters can tell the two apart, and a description carries
// none — so every marker survives.
assert.deepEqual(
  parseJsDocPreview('* imported modules\n* exported providers'),
  [{ kind: 'list', items: ['imported modules', 'exported providers'] }]
)

// A description whose every line happens to start with `*` is still a list.
assert.deepEqual(
  parseJsDocPreview('* one'),
  [{ kind: 'list', items: ['one'] }]
)

// ts-morph hands over comment text, not the comment — but one read from
// anywhere else still arrives wrapped, and a column of asterisks is not
// content. The delimiters are what say so.
assert.deepEqual(
  parseJsDocPreview(
    '/**\n * OrderNotificationService has a cycle.\n * Uses forwardRef.\n */'
  ),
  [
    {
      kind: 'paragraph',
      text: 'OrderNotificationService has a cycle. Uses forwardRef.'
    }
  ]
)

// A wrapped comment keeps its bullets too, gutter and marker being distinct.
assert.deepEqual(
  parseJsDocPreview('/**\n * Collects:\n * - imports\n * - exports\n */'),
  [
    { kind: 'paragraph', text: 'Collects:' },
    { kind: 'list', items: ['imports', 'exports'] }
  ] satisfies JsDocPreviewBlock[]
)

// A plain block comment is unwrapped the same way a doc comment is.
assert.deepEqual(
  parseJsDocPreview('/* Legacy note. */'),
  [{ kind: 'paragraph', text: 'Legacy note.' }]
)

// An unterminated wrapper is not a wrapper, and must not lose its first line.
assert.deepEqual(
  parseJsDocPreview('/** Half a comment'),
  [{ kind: 'paragraph', text: '/** Half a comment' }]
)

// Windows line endings arrive from Windows checkouts and must not survive into
// the rendered text.
assert.deepEqual(
  parseJsDocPreview('First line.\r\n\r\n- one\r\n- two'),
  [
    { kind: 'paragraph', text: 'First line.' },
    { kind: 'list', items: ['one', 'two'] }
  ]
)

console.log('jsdoc-preview.test.ts ok')
