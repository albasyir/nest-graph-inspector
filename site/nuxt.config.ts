// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  app: {
    baseURL: process.env.NUXT_APP_BASE_URL || '/'
  },

  modules: [
    '@nuxt/eslint',
    '@nuxt/image',
    '@nuxt/ui',
    '@nuxt/content',
    'nuxt-og-image',
    'nuxt-llms',
    '@nuxtjs/mcp-toolkit',
    '@posthog/nuxt'
  ],

  runtimeConfig: {
    public: {
      posthog: {
        publicKey: process.env.NUXT_PUBLIC_POSTHOG_PROJECT_TOKEN || 'phc_CbFFE2bzfQCU5uSmrFbQRyMtjN8rGqBakxqE4ZdhCyyU',
        host: process.env.NUXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
      }
    }
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
  },

  devtools: {
    enabled: true
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
    description: 'A NestJS module to generate runtime dependency graphs in Markdown + Mermaid or JSON format.',
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
        title: 'Guide',
        contentCollection: 'docs',
        contentFilters: [
          { field: 'path', operator: 'LIKE', value: '/guide%' }
        ]
      }
    ]
  },

  mcp: {
    name: 'Nest Graph Inspector'
  }
})
