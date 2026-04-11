export default defineAppConfig({
  ui: {
    colors: {
      primary: 'red',
      neutral: 'slate'
    },
    footer: {
      slots: {
        root: 'border-t border-default',
        left: 'text-sm text-muted'
      }
    }
  },
  seo: {
    siteName: 'Nest Graph Inspector'
  },
  header: {
    title: 'Nest Graph Inspector',
    logo: {
      light: '/logo.png',
      dark: '/logo.png',
      alt: 'Nest Graph Inspector Logo'
    },
    to: '/',
    search: true,
    colorMode: true,
    links: [{
      'icon': 'i-simple-icons-github',
      'to': 'https://github.com/albasyir/nest-graph-inspector',
      'target': '_blank',
      'aria-label': 'GitHub'
    }, {
      'icon': 'i-simple-icons-npm',
      'to': 'https://www.npmjs.com/package/nest-graph-inspector',
      'target': '_blank',
      'aria-label': 'NPM'
    }]
  },
  footer: {
    credits: `Nest Graph Inspector \u00B7 MIT License \u00B7 \u00A9 ${new Date().getFullYear()}`,
    colorMode: false,
    links: [{
      'icon': 'i-lucide-network',
      'to': '/view',
      'aria-label': 'View Graph and Inspect'
    }, {
      'icon': 'i-simple-icons-github',
      'to': 'https://github.com/albasyir/nest-graph-inspector',
      'target': '_blank',
      'aria-label': 'GitHub'
    }, {
      'icon': 'i-simple-icons-npm',
      'to': 'https://www.npmjs.com/package/nest-graph-inspector',
      'target': '_blank',
      'aria-label': 'NPM'
    }]
  },
  toc: {
    title: 'Table of Contents',
    bottom: {
      title: 'Community',
      edit: 'https://github.com/albasyir/nest-graph-inspector/edit/main/site/content',
      links: [{
        icon: 'i-lucide-star',
        label: 'Star on GitHub',
        to: 'https://github.com/albasyir/nest-graph-inspector',
        target: '_blank'
      }, {
        icon: 'i-lucide-bug',
        label: 'Report an issue',
        to: 'https://github.com/albasyir/nest-graph-inspector/issues',
        target: '_blank'
      }]
    }
  }
})
