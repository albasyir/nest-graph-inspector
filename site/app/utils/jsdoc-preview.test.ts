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

// ts-morph strips the comment gutter, but a comment read from anywhere else may
// still carry it — and a column of asterisks is not content.
assert.deepEqual(
  parseJsDocPreview(' * OrderNotificationService has a cycle.\n * Uses forwardRef.'),
  [
    {
      kind: 'paragraph',
      text: 'OrderNotificationService has a cycle. Uses forwardRef.'
    }
  ]
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
