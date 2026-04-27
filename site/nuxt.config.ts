// https://nuxt.com/docs/api/configuration/nuxt-config
import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/image',
    '@nuxt/ui',
    '@nuxt/content',
    '@pinia/nuxt',
    'nuxt-og-image',
    'nuxt-llms',
    '@nuxtjs/mcp-toolkit',
    '@posthog/nuxt'
  ],

  devtools: {
    enabled: true
  },

  app: {
    baseURL: process.env.NUXT_APP_BASE_URL || '/'
  },

  css: ['~/assets/css/main.css'],

  content: {
    build: {
      markdown: {
        toc: {
          searchDepth: 1
        }
      }
    }
  },

  runtimeConfig: {
    public: {
      posthog: {
        publicKey: process.env.NUXT_PUBLIC_POSTHOG_PROJECT_TOKEN || 'phc_CbFFE2bzfQCU5uSmrFbQRyMtjN8rGqBakxqE4ZdhCyyU',
        host: process.env.NUXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'
      }
    }
  },

  alias: {
    '@library': fileURLToPath(new URL('../library', import.meta.url))
  },

  experimental: {
    asyncContext: true
  },

  compatibilityDate: '2024-07-11',

  nitro: {
    prerender: {
      routes: [
        '/'
      ],
      crawlLinks: true,
      autoSubfolderIndex: false
    },
    rollupConfig: {
      output: {
        sourcemapExcludeSources: false
      }
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  icon: {
    provider: 'iconify'
  },

  llms: {
    domain: 'https://nest-graph-inspector.dev/',
    title: 'Nest Graph Inspector',
    description: 'A NestJS module to generate runtime dependency graphs to view dynamically in an Interactive Web Viewer or via JSON format.',
    full: {
      title: 'Nest Graph Inspector - Full Documentation',
      description: 'Complete documentation for Nest Graph Inspector, a NestJS module for runtime dependency graph generation.'
    },
    sections: [
      {
        title: 'Getting Started',
        contentCollection: 'docs',
        contentFilters: [
          { field: 'path', operator: 'LIKE', value: '/getting-started%' }
        ]
      },
      {
        title: 'Configuration',
        contentCollection: 'docs',
        contentFilters: [
          { field: 'path', operator: 'LIKE', value: '/configuration%' }
        ]
      },
      {
        title: 'Internals',
        contentCollection: 'docs',
        contentFilters: [
          { field: 'path', operator: 'LIKE', value: '/guide%' }
        ]
      }
    ]
  },

  mcp: {
    name: 'Nest Graph Inspector'
  },

  posthogConfig: {
    publicKey: process.env.NUXT_PUBLIC_POSTHOG_PROJECT_TOKEN || 'phc_CbFFE2bzfQCU5uSmrFbQRyMtjN8rGqBakxqE4ZdhCyyU',
    host: process.env.NUXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
    clientConfig: {
      api_host: 'https://integrity.nest-graph-inspector.albasyir.net',
      ui_host: 'https://us.posthog.com',
      capture_exceptions: true
    },
    serverConfig: {
      enableExceptionAutocapture: true
    }
  }
})
