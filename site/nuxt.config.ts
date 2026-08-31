// https://nuxt.com/docs/api/configuration/nuxt-config

/** A JSDoc example in web-llm's bundle, and nothing else in it, writes this. */
const WEB_LLM_DOC_COMMENT_IMPORT_META_URL = /^(\s*\*.*?)\bimport\.meta\.url\b/gm

/**
 * Keeps Vite from tokenizing web-llm's bundle looking for asset URLs.
 *
 * `vite:asset-import-meta-url` rewrites `new URL(..., import.meta.url)` into a
 * built asset path, and it decides whether a module is worth looking at by
 * searching the source for `import.meta.url`. web-llm's bundle contains that
 * string exactly once, inside a JSDoc example showing how to construct a
 * worker — so the plugin runs its literal-stripping tokenizer over all 6.5 MB
 * of it, including one 4.7 MB line of embedded shader source, and the
 * tokenizer's regex overflows the stack. The build then fails outright, first
 * in the sub-build for the inference worker, which is the one module that
 * imports the library directly.
 *
 * Renaming the mention inside the comment is invisible to the shipped code and
 * takes the whole file off that plugin's list. Deliberately restricted to
 * comment lines: a real `import.meta.url` in a future release has to keep being
 * rewritten, or the asset it points at would not ship.
 */
const skipWebLlmAssetUrlScan = {
  name: 'nest-graph-inspector:web-llm-import-meta-url',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.includes('@mlc-ai/web-llm') || !code.includes('import.meta.url')) {
      return null
    }

    return {
      code: code.replace(WEB_LLM_DOC_COMMENT_IMPORT_META_URL, '$1import.meta.URL'),
      map: null
    }
  }
}

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

  // The AI chat runs its model in the browser, through `@mlc-ai/web-llm` on a
  // worker thread. Three things about that package need saying here; nothing
  // else about it does, because `useWebLlmEngine` only ever reaches it through
  // a dynamic `import()`, which keeps it out of the server bundle on its own.
  vite: {
    plugins: [skipWebLlmAssetUrlScan],

    // It is one self-contained ES module with no dependencies of its own, so
    // there is no CommonJS interop for the dev optimizer to earn its keep on —
    // and the copy that matters is the one the Web Worker imports, where Vite
    // cannot recover from re-optimizing a dependency mid-session the way it can
    // reload a page. Serving it as-is keeps the worker and the main thread on
    // the same file.
    optimizeDeps: {
      exclude: ['@mlc-ai/web-llm']
    },

    // `useWebLlmEngine` starts the worker with `{ type: 'module' }`, which is
    // what the dev server always serves. Vite's default worker output is an
    // IIFE, so without this the worker shipped to production is a different
    // kind of file from the one every dev session exercises.
    worker: {
      format: 'es',

      // The worker is bundled by a build of its own, and that build does not
      // inherit `vite.plugins` — so the plugin above has to be handed to it
      // again. This is the build that actually needs it: the worker entry is
      // the one module that imports web-llm statically.
      plugins: () => [skipWebLlmAssetUrlScan]
    }
  },

  hooks: {
    // web-llm's runtime is a 6 MB chunk, and Nuxt prefetches every dynamic
    // import reachable from a rendered page. The homepage renders the chat
    // panel in preview mode — a mock that never loads a model — so without this
    // every visitor to the marketing page quietly pulls those 6 MB down on
    // idle. Dropping it from the manifest's prefetch and preload sets does not
    // make it unreachable: the `import()` in `useWebLlmEngine` still fetches it
    // the moment someone actually asks for a model.
    'build:manifest'(manifest) {
      for (const resource of Object.values(manifest)) {
        if (resource.src?.includes('@mlc-ai/web-llm')) {
          resource.prefetch = false
          resource.preload = false
        }
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
