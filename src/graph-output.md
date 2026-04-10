# NestJS Dependency Graph

Root Module: `AppModule`
Version: `1`

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

## Legend

- Each module is rendered as a Mermaid group
- Inside each module group: providers and controllers owned by that module
- Arrows between groups: imported module points to importing module
- Arrows point from dependency/owned node to the dependent/owner node
- Providers and controllers are grouped inside their owning module without extra ownership arrows
- Internal and external runtime dependencies point to the provider/controller that uses them
- Standalone dependency nodes are only used when a dependency cannot be resolved to a provider node

## AppModule

### Imports
- UserModule
- ProductModule
- OrderModule

### Exports
- None

### Providers
- None

### Controllers
- None

## UserModule

### Imports
- None

### Exports
- UserService

### Providers
- UserService
  - depends on: UserRepository
- UserRepository

### Controllers
- UserController
  - depends on: UserService

## ProductModule

### Imports
- UserModule

### Exports
- ProductService

### Providers
- ProductService
  - depends on: ProductRepository
- ProductRepository

### Controllers
- ProductController
  - depends on: ProductService

## OrderModule

### Imports
- UserModule
- ProductModule

### Exports
- OrderService

### Providers
- OrderRepository
- OrderService
  - depends on: OrderRepository
  - depends on: UserModule:UserService
  - depends on: ProductModule:ProductService
  - depends on: OrderNotificationService
- OrderNotificationService
  - depends on: OrderService

### Controllers
- OrderController
  - depends on: OrderService
  - depends on: NestJSCoreModule:ModuleRef
  - depends on: OrderNotificationService

## NestJSCoreModule

### Imports
- None

### Exports
- ModuleRef

### Providers
- ModuleRef

### Controllers
- None
