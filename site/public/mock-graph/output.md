# NestJS Dependency Graph

```mermaid
graph TD

  subgraph module_group_AppModule["AppModule"]
  end
  subgraph module_group_UserModule["UserModule"]
    provider_UserModule_UserService["UserService"]
    provider_UserModule_UserRepository["UserRepository"]
    provider_UserModule_UserSchedule["UserSchedule"]
    controller_UserModule_UserController["UserController"]
  end
  subgraph module_group_MobileModule["MobileModule"]
    provider_MobileModule_MobileService["MobileService"]
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
  module_group_UserModule --> module_group_MobileModule
  provider_UserModule_UserService --> provider_UserModule_UserRepository
  provider_UserModule_UserService --> provider_MobileModule_MobileService
  provider_UserModule_UserSchedule --> provider_UserModule_UserRepository
  controller_UserModule_UserController --> provider_UserModule_UserService
  controller_UserModule_UserController --> provider_UserModule_UserSchedule
  module_group_MobileModule --> module_group_ProductModule
  provider_MobileModule_MobileService --> provider_ProductModule_ProductService
  module_group_ProductModule --> module_group_UserModule
  module_group_ProductModule --> module_group_MobileModule
  provider_ProductModule_ProductService --> provider_ProductModule_ProductRepository
  provider_ProductModule_ProductService --> provider_MobileModule_MobileService
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

This is playground root module 
that imports the feature modules and the Nest Graph Inspector module.

### Imports
- UserModule
- ProductModule
- OrderModule

## UserModule

UserModule is example feature

> warnings
> - indirect circular dependency with MobileModule

### Imports
- MobileModule

### Exports
- UserService

### Providers
- UserService
  - depends on UserRepository from UserModule
  - depends on MobileService from MobileModule
- UserRepository
- UserSchedule
  scheduler for user module

  - depends on UserRepository from UserModule

### Controllers
- UserController
  - depends on UserService from UserModule
  - depends on UserSchedule from UserModule

## MobileModule

> warnings
> - direct circular dependency with ProductModule

### Imports
- ProductModule

### Exports
- MobileService

### Providers
- MobileService
  - Warning: direct circular dependency with ProductService from ProductModule
  - depends on ProductService from ProductModule

## ProductModule

ProductModule imports UserModule but does NOT use any of its providers.
This is an intentionally useless import to test graph-inspector detection.

### Imports
- UserModule
  - Warning: unused import module
- MobileModule

### Exports
- ProductService

### Providers
- ProductService
  - depends on ProductRepository from ProductModule
  - depends on MobileService from MobileModule
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
  - Warning: direct circular dependency with OrderNotificationService from OrderModule
  - depends on OrderRepository from OrderModule
  - depends on UserService from UserModule
  - depends on ProductService from ProductModule
  - depends on OrderNotificationService from OrderModule
- OrderNotificationService
  OrderNotificationService has a circular dependency with OrderService.
  Uses forwardRef in constructor

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
