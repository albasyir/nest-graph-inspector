import { redactAnalyticsEvent } from '~/utils/analytics-privacy'

/**
 * Rewrites viewer routes out of every event PostHog sends: see
 * `utils/analytics-privacy.ts`.
 *
 * Set once PostHog has initialised, which is all `before_send` needs: PostHog
 * sends its first pageview on a timer after initialising, and the plugins in
 * between run without waiting on anything.
 */
export default defineNuxtPlugin({
  name: 'posthog-privacy',
  dependsOn: ['posthog-client'],
  setup() {
    usePostHog()?.set_config({ before_send: redactAnalyticsEvent })
  }
})
