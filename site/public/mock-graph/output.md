# NestJS Dependency Graph

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
  module_group_AppModule --> module_group_UserModule
  module_group_AppModule --> module_group_ProductModule
  module_group_AppModule --> module_group_OrderModule
  provider_UserModule_UserService --> provider_UserModule_UserRepository
  controller_UserModule_UserController --> provider_UserModule_UserService
  module_group_ProductModule --> module_group_UserModule
  provider_ProductModule_ProductService --> provider_ProductModule_ProductRepository
  controller_ProductModule_ProductController --> provider_ProductModule_ProductService
  module_group_OrderModule --> module_group_UserModule
  module_group_OrderModule --> module_group_ProductModule
  provider_OrderModule_OrderService --> provider_OrderModule_OrderRepository
  provider_OrderModule_OrderService --> provider_UserModule_UserService
  provider_OrderModule_OrderService --> provider_ProductModule_ProductService
  provider_OrderModule_OrderService --> provider_OrderModule_OrderNotificationService
  provider_OrderModule_OrderNotificationService --> provider_OrderModule_OrderService
  controller_OrderModule_OrderController --> provider_OrderModule_OrderService
  controller_OrderModule_OrderController --> provider_NestJSCoreModule_ModuleRef
  controller_OrderModule_OrderController --> provider_OrderModule_OrderNotificationService
```

> Arrow direction: `A --> B` means `A` depends on `B`.

## AppModule

### Imports
- UserModule
- ProductModule
- OrderModule

## UserModule

### Exports
- UserService

### Providers
- UserService
  - depends on UserRepository from UserModule
- UserRepository

### Controllers
- UserController
  - depends on UserService from UserModule

## ProductModule

### Imports
- UserModule

### Exports
- ProductService

### Providers
- ProductService
  - depends on ProductRepository from ProductModule
- ProductRepository

### Controllers
- ProductController
  - depends on ProductService from ProductModule

## OrderModule

### Imports
- UserModule
- ProductModule

### Exports
- OrderService

### Providers
- OrderRepository
- OrderService
  - depends on OrderRepository from OrderModule
  - depends on UserService from UserModule
  - depends on ProductService from ProductModule
  - depends on OrderNotificationService from OrderModule
- OrderNotificationService
  - depends on OrderService from OrderModule

### Controllers
- OrderController
  - depends on OrderService from OrderModule
  - depends on ModuleRef from NestJSCoreModule
  - depends on OrderNotificationService from OrderModule

## NestJSCoreModule

### Exports
- ModuleRef

### Providers
- ModuleRef
