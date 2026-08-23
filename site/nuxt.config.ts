// https://nuxt.com/docs/api/configuration/nuxt-config

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

  // The viewer is a browser-only surface: the graph it shows lives on the
  // developer's own machine, and which graph a tab is on lives in that tab's
  // session storage. A server render can see neither, so it would always render
  // "no graph" and then disagree with the client's first paint. Rendering these
  // routes client-side only removes that whole class of hydration mismatch, and
  // matches how they already behave in production, where they are served as the
  // static host's SPA fallback.
  routeRules: {
    // `/view/**` also matches `/view`, so the entry page needs an explicit
    // override: it renders nothing that depends on the tab's session, and it is
    // linked from the homepage, so it keeps its prerendered HTML, title and OG
    // tags for crawlers and link unfurlers.
    '/view': { ssr: true },
    '/view/**': { ssr: false }
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

  fonts: {
    families: [
      { name: 'Public Sans', provider: 'none' }
    ]
  },

  icon: {
    provider: 'iconify'
  },

  llms: {
    domain: 'https://albasyir.github.io/nest-graph-inspector/',
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

  ogImage: {
    enabled: true
  },

  posthogConfig: {
    publicKey: process.env.NUXT_PUBLIC_POSTHOG_PROJECT_TOKEN || 'XXXphc_CbFFE2bzfQCU5uSmrFbQRyMtjN8rGqBakxqE4ZdhCyyU',
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
