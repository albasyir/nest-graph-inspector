import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { redactAnalyticsEvent, redactViewerRoutes } from './analytics-privacy.ts'

const SITE = 'https://albasyir.github.io/nest-graph-inspector'

describe('a viewer route in an analytics event', () => {
  test('keeps the viewer page it names', () => {
    for (const page of ['/view', '/view/navigator', '/view/issues', '/view/trace']) {
      assert.equal(redactViewerRoutes(`${SITE}${page}`), `${SITE}${page}`)
    }
  })

  test('loses the module a deep dive names', () => {
    assert.equal(
      redactViewerRoutes(`${SITE}/view/navigator/modules/PaymentsLedgerModule`),
      `${SITE}/view/navigator/modules/[module]`
    )
    assert.equal(redactViewerRoutes('/view/navigator/modules/Already%2520Encoded'), '/view/navigator/modules/[module]')
  })

  test('loses its query and fragment, where the navigator names a module or a provider', () => {
    assert.equal(
      redactViewerRoutes(`${SITE}/view/navigator?focus-module=PaymentsLedgerModule#top`),
      `${SITE}/view/navigator`
    )
    assert.equal(
      redactViewerRoutes(`${SITE}/view/navigator/modules/Ledger?direct-run-on=provider-Ledger-LedgerService`),
      `${SITE}/view/navigator/modules/[module]`
    )
    assert.equal(redactViewerRoutes(`${SITE}/view?preview=true`), `${SITE}/view`)
  })

  test('that is a printed link is named by its shape', () => {
    assert.equal(redactViewerRoutes(`${SITE}/view/aHR0cDovL2xvY2FsaG9zdDo1MzM3MQ`), `${SITE}/view/[url]`)
  })

  test('leaves every other page alone', () => {
    for (const url of [
      `${SITE}/`,
      `${SITE}/getting-started/export-graph?tab=cli#viewing`,
      `${SITE}/guide/viewer`,
      `${SITE}/docs/view-graph`,
      'https://github.com/albasyir/nest-graph-inspector'
    ]) {
      assert.equal(redactViewerRoutes(url), url)
    }
  })
})

describe('an analytics event', () => {
  const timestamp = new Date('2026-11-02T00:00:00Z')

  test('has every viewer route in it redacted, at any depth and in keys', () => {
    const deepDive = `${SITE}/view/navigator/modules/LedgerModule`
    const redacted = redactAnalyticsEvent({
      event: '$autocapture',
      timestamp,
      properties: {
        $current_url: deepDive,
        $pathname: '/nest-graph-inspector/view/navigator/modules/LedgerModule',
        $session_entry_url: `${SITE}/view/navigator?focus-module=LedgerModule`,
        $heatmap_data: { [deepDive]: [{ x: 1, y: 2 }] },
        $elements: [{ attr__href: '/view/navigator/modules/LedgerModule' }],
        count: 3,
        flag: true,
        nothing: null
      },
      $set_once: { $initial_current_url: deepDive }
    })

    assert.deepEqual(redacted, {
      event: '$autocapture',
      timestamp,
      properties: {
        $current_url: `${SITE}/view/navigator/modules/[module]`,
        $pathname: '/nest-graph-inspector/view/navigator/modules/[module]',
        $session_entry_url: `${SITE}/view/navigator`,
        $heatmap_data: { [`${SITE}/view/navigator/modules/[module]`]: [{ x: 1, y: 2 }] },
        $elements: [{ attr__href: '/view/navigator/modules/[module]' }],
        count: 3,
        flag: true,
        nothing: null
      },
      $set_once: { $initial_current_url: `${SITE}/view/navigator/modules/[module]` }
    })
    assert.ok(redacted.timestamp instanceof Date)
    assert.ok(!JSON.stringify(redacted).includes('LedgerModule'))
  })

  // No viewer page names the graph in its title; one that ever did must not
  // carry it out in an event.
  test('captured on a viewer page loses the page title', () => {
    const viewer = redactAnalyticsEvent({
      event: '$pageview',
      properties: { $current_url: `${SITE}/view/navigator/modules/LedgerModule`, title: 'LedgerModule - Module Deep Dive' }
    })
    const docs = redactAnalyticsEvent({
      event: '$pageview',
      properties: { $current_url: `${SITE}/getting-started`, title: 'Getting Started' }
    })

    assert.equal('title' in viewer.properties, false)
    assert.equal(docs.properties.title, 'Getting Started')
  })

  test('that PostHog dropped stays dropped', () => {
    assert.equal(redactAnalyticsEvent(null), null)
  })
})
