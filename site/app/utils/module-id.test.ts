import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { decodeModuleId, encodeModuleId } from './module-id.ts'

// Every character an id may contain without being read as URL structure.
const UNRESERVED_OR_ESCAPE = /^[A-Za-z0-9\-._~%]*$/

const NAMES = [
  'UserModule',
  'NestJSCoreModule',
  'ConfigModule',
  'feature/UserModule',
  '@scope/pkg/Module',
  'User Module',
  '  padded  ',
  'Already%20Encoded',
  '100%',
  'a?b#c&d=e',
  'it\'s (dynamic)*!',
  'Foo.Bar',
  '.',
  '..',
  '...',
  'Módulo',
  '模块',
  'Rocket🚀Module',
  ''
]

describe('encodeModuleId', () => {
  test('an ordinary class name is left readable', () => {
    assert.equal(encodeModuleId('UserModule'), 'UserModule')
    assert.equal(encodeModuleId('Foo.Bar'), 'Foo.Bar')
  })

  test('a slash is escaped, so the id stays one path segment', () => {
    assert.equal(encodeModuleId('feature/UserModule'), 'feature%2FUserModule')
  })

  test('a space is escaped as %20, not +', () => {
    assert.equal(encodeModuleId('User Module'), 'User%20Module')
  })

  test('an existing escape is escaped again, so it is not decoded twice', () => {
    assert.equal(encodeModuleId('Already%20Encoded'), 'Already%2520Encoded')
  })

  test('the sub-delimiters encodeURIComponent leaves alone are escaped too', () => {
    assert.equal(encodeModuleId('!\'()*'), '%21%27%28%29%2A')
  })

  test('a name made only of dots cannot become a dot-segment', () => {
    assert.equal(encodeModuleId('.'), '%2E')
    assert.equal(encodeModuleId('..'), '%2E%2E')
  })

  test('every id is built from unreserved characters and escapes only', () => {
    for (const name of NAMES) {
      assert.match(encodeModuleId(name), UNRESERVED_OR_ESCAPE, JSON.stringify(name))
    }
  })
})

describe('decodeModuleId', () => {
  test('reverses encodeModuleId for every name', () => {
    for (const name of NAMES) {
      assert.equal(decodeModuleId(encodeModuleId(name)), name, JSON.stringify(name))
    }
  })

  test('two different names never share an id', () => {
    const ids = NAMES.map(encodeModuleId)

    assert.equal(new Set(ids).size, NAMES.length)
  })

  test('accepts a lowercase escape, as a browser may hand one back', () => {
    assert.equal(decodeModuleId('feature%2fUserModule'), 'feature/UserModule')
  })

  test('a malformed escape throws rather than decoding to a guess', () => {
    assert.throws(() => decodeModuleId('%E0%A4%A'), URIError)
    assert.throws(() => decodeModuleId('%'), URIError)
  })
})
