<p align="center">
  <a href="https://albasyir.github.io/nest-graph-inspector/" target="_blank"><img src="https://albasyir.github.io/nest-graph-inspector/logo.png" width="120" alt="Nest Graph Inspector Logo" /></a>
</p>

<h1 align="center">Nest Graph Inspector</h1>

<p align="center">
<a href="https://www.npmjs.com/package/nest-graph-inspector" target="_blank"><img src="https://img.shields.io/npm/v/nest-graph-inspector.svg" alt="NPM Version" /></a>
<a href="https://github.com/albasyir/nest-graph-inspector/blob/main/LICENSE" target="_blank"><img src="https://img.shields.io/npm/l/nest-graph-inspector.svg" alt="Package License" /></a>
<a href="https://github.com/albasyir/nest-graph-inspector" target="_blank"><img src="https://img.shields.io/github/stars/albasyir/nest-graph-inspector?style=social" alt="Github Stars" /></a>
</p>

Nest Graph Inspector reads your NestJS runtime container and generates a dependency graph of modules, providers, controllers, and their relationships.

### Preview

> This is a static preview. [**Try the interactive viewer →**](https://albasyir.github.io/nest-graph-inspector/view/aHR0cHM6Ly9hbGJhc3lpci5naXRodWIuaW8vbmVzdC1ncmFwaC1pbnNwZWN0b3IvZ3JhcGgtb3V0cHV0Lmpzb24=)

```mermaid
graph TD
  subgraph module_group_AppModule["AppModule"]
  end
  subgraph module_group_UserModule["UserModule"]
    provider_UserModule_UserService["UserService"]
    provider_UserModule_UserRepository["UserRepository"]
    controller_UserModule_UserController["UserController"]
  end
  subgraph module_group_ProductModule["ProductModule"]
    provider_ProductModule_ProductService["ProductService"]
    provider_ProductModule_ProductRepository["ProductRepository"]
    controller_ProductModule_ProductController["ProductController"]
  end
  subgraph module_group_OrderModule["OrderModule"]
    provider_OrderModule_OrderRepository["OrderRepository"]
    provider_OrderModule_OrderService["OrderService"]
    provider_OrderModule_OrderNotificationService["OrderNotificationService"]
    controller_OrderModule_OrderController["OrderController"]
  end
  subgraph module_group_NestJSCoreModule["NestJSCoreModule"]
    provider_NestJSCoreModule_ModuleRef["ModuleRef"]
  end
  module_group_UserModule --> module_group_AppModule
  module_group_ProductModule --> module_group_AppModule
  module_group_OrderModule --> module_group_AppModule
  provider_UserModule_UserRepository --> provider_UserModule_UserService
  provider_UserModule_UserService --> controller_UserModule_UserController
  module_group_UserModule --> module_group_ProductModule
  provider_ProductModule_ProductRepository --> provider_ProductModule_ProductService
  provider_ProductModule_ProductService --> controller_ProductModule_ProductController
  module_group_UserModule --> module_group_OrderModule
  module_group_ProductModule --> module_group_OrderModule
  provider_OrderModule_OrderRepository --> provider_OrderModule_OrderService
  provider_UserModule_UserService --> provider_OrderModule_OrderService
  provider_ProductModule_ProductService --> provider_OrderModule_OrderService
  provider_OrderModule_OrderNotificationService --> provider_OrderModule_OrderService
  provider_OrderModule_OrderService --> provider_OrderModule_OrderNotificationService
  provider_OrderModule_OrderService --> controller_OrderModule_OrderController
  provider_NestJSCoreModule_ModuleRef --> controller_OrderModule_OrderController
  provider_OrderModule_OrderNotificationService --> controller_OrderModule_OrderController
```

## Features

- **Runtime introspection** — graphs are built from the actual Nest container, not static source parsing
- **Minimal setup** — import the module and you're done
- **Interactive web viewer** — zoom, pan, and inspect nodes in the browser
- **JSON output** — structured data for programmatic use or CI integration
- **Markdown output** — AI-friendly graph representation


## Quick Start

```bash
npm install nest-graph-inspector 
```

> it's not only NPM, see [installation](https://albasyir.github.io/nest-graph-inspector/getting-started) for other package manager

```ts
import { Module } from '@nestjs/common';
import { NestGraphInspector } from 'nest-graph-inspector';

@Module({
  imports: [NestGraphInspector],
})
export class RootModule {}
```

Start your app — the viewer URL will be printed in your console.

> For full configuration options and output types, see the **[documentation →](https://albasyir.github.io/nest-graph-inspector/getting-started)**

## Documentation

Full setup guide, configuration options, and use cases are available on the documentation site.

<p align="center">
  <a href="https://albasyir.github.io/nest-graph-inspector/"><strong>📖 View Documentation →</strong></a>
</p>

## Stay in touch

- [Documentation](https://albasyir.github.io/nest-graph-inspector/)
- [NPM Package](https://www.npmjs.com/package/nest-graph-inspector)
- [GitHub Repository](https://github.com/albasyir/nest-graph-inspector)
- [Maintainer, Abdul Aziz Al Basyir](https://github.com/albasyir)
