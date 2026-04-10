# NestJS Dependency Graph

Root Module: `AppModule`
Version: `1`

```mermaid
graph TD

  subgraph module_group_AppModule["AppModule"]
    provider_AppModule_AppService["AppService"]
    controller_AppModule_AppController["AppController"]
  end
  subgraph module_group_UserModule["UserModule"]
    provider_UserModule_CreateUserUsecase["CreateUserUsecase"]
    controller_UserModule_UserController["UserController"]
  end
  subgraph module_group_UserDeprecatedModule["UserDeprecatedModule"]
    provider_UserDeprecatedModule_UserDeprecatedService["UserDeprecatedService"]
    provider_UserDeprecatedModule_CreateUserUsecase["CreateUserUsecase"]
    controller_UserDeprecatedModule_UserDeprecatedController["UserDeprecatedController"]
  end
  subgraph module_group_NestJSCoreModule["NestJSCoreModule"]
    provider_NestJSCoreModule_ModuleRef["ModuleRef"]
  end
  module_group_UserModule --> module_group_AppModule
  module_group_UserDeprecatedModule --> module_group_AppModule
  provider_UserDeprecatedModule_CreateUserUsecase --> provider_AppModule_AppService
  provider_NestJSCoreModule_ModuleRef --> provider_AppModule_AppService
  provider_AppModule_AppService --> controller_AppModule_AppController
  provider_NestJSCoreModule_ModuleRef --> controller_AppModule_AppController
  provider_UserModule_CreateUserUsecase --> controller_AppModule_AppController
  module_group_UserDeprecatedModule --> module_group_UserModule
  provider_UserModule_CreateUserUsecase --> controller_UserModule_UserController
  provider_UserDeprecatedModule_UserDeprecatedService --> controller_UserDeprecatedModule_UserDeprecatedController
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
- UserDeprecatedModule

### Exports
- None

### Providers
- AppService
  - depends on: UserDeprecatedModule:CreateUserUsecase
  - depends on: NestJSCoreModule:ModuleRef

### Controllers
- AppController
  - depends on: AppService
  - depends on: NestJSCoreModule:ModuleRef
  - depends on: UserModule:CreateUserUsecase

## UserModule

### Imports
- UserDeprecatedModule

### Exports
- CreateUserUsecase

### Providers
- CreateUserUsecase

### Controllers
- UserController
  - depends on: CreateUserUsecase

## UserDeprecatedModule

### Imports
- None

### Exports
- CreateUserUsecase

### Providers
- UserDeprecatedService
- CreateUserUsecase

### Controllers
- UserDeprecatedController
  - depends on: UserDeprecatedService

## NestJSCoreModule

### Imports
- None

### Exports
- ModuleRef

### Providers
- ModuleRef

### Controllers
- None
