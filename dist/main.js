/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./src/app.controller.ts":
/*!*******************************!*\
  !*** ./src/app.controller.ts ***!
  \*******************************/
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var _a, _b;
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AppController = void 0;
const common_1 = __webpack_require__(/*! @nestjs/common */ "@nestjs/common");
const app_service_1 = __webpack_require__(/*! ./app.service */ "./src/app.service.ts");
const create_test1_usecase_1 = __webpack_require__(/*! ./test1/usecases/create-test1.usecase */ "./src/test1/usecases/create-test1.usecase.ts");
let AppController = class AppController {
    appService;
    createTest1Usecase;
    constructor(appService, createTest1Usecase) {
        this.appService = appService;
        this.createTest1Usecase = createTest1Usecase;
    }
    getHello() {
        return this.appService.getHello();
    }
};
exports.AppController = AppController;
__decorate([
    (0, common_1.Get)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", String)
], AppController.prototype, "getHello", null);
exports.AppController = AppController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [typeof (_a = typeof app_service_1.AppService !== "undefined" && app_service_1.AppService) === "function" ? _a : Object, typeof (_b = typeof create_test1_usecase_1.CreateTest1Usecase !== "undefined" && create_test1_usecase_1.CreateTest1Usecase) === "function" ? _b : Object])
], AppController);


/***/ }),

/***/ "./src/app.module.ts":
/*!***************************!*\
  !*** ./src/app.module.ts ***!
  \***************************/
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AppModule = void 0;
const common_1 = __webpack_require__(/*! @nestjs/common */ "@nestjs/common");
const app_controller_1 = __webpack_require__(/*! ./app.controller */ "./src/app.controller.ts");
const app_service_1 = __webpack_require__(/*! ./app.service */ "./src/app.service.ts");
const nestjs_devtool_service_1 = __webpack_require__(/*! ./nestjs-devtool.service */ "./src/nestjs-devtool.service.ts");
const test1_module_1 = __webpack_require__(/*! ./test1/test1.module */ "./src/test1/test1.module.ts");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [test1_module_1.Test1Module],
        controllers: [app_controller_1.AppController],
        providers: [app_service_1.AppService, nestjs_devtool_service_1.ModuleGraphService],
    })
], AppModule);


/***/ }),

/***/ "./src/app.service.ts":
/*!****************************!*\
  !*** ./src/app.service.ts ***!
  \****************************/
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AppService = void 0;
const common_1 = __webpack_require__(/*! @nestjs/common */ "@nestjs/common");
let AppService = class AppService {
    getHello() {
        return 'Hello World!';
    }
};
exports.AppService = AppService;
exports.AppService = AppService = __decorate([
    (0, common_1.Injectable)()
], AppService);


/***/ }),

/***/ "./src/nestjs-devtool.service.ts":
/*!***************************************!*\
  !*** ./src/nestjs-devtool.service.ts ***!
  \***************************************/
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var _a;
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ModuleGraphService = void 0;
__webpack_require__(/*! reflect-metadata */ "reflect-metadata");
const common_1 = __webpack_require__(/*! @nestjs/common */ "@nestjs/common");
const core_1 = __webpack_require__(/*! @nestjs/core */ "@nestjs/core");
const app_module_1 = __webpack_require__(/*! ./app.module */ "./src/app.module.ts");
let ModuleGraphService = class ModuleGraphService {
    modulesContainer;
    constructor(modulesContainer) {
        this.modulesContainer = modulesContainer;
    }
    ignoreProvider = ['ModuleRef', 'ApplicationConfig'];
    ignoreImport = ['InternalCoreModule'];
    onModuleInit() {
        const moduleMap = this.buildModuleMap(app_module_1.AppModule);
        console.log(JSON.stringify(moduleMap, null, 2));
    }
    buildModuleMap(rootModuleClass) {
        const root = [...this.modulesContainer.values()].find((m) => m.metatype === rootModuleClass);
        if (!root) {
            throw new Error(`Root module not found: ${rootModuleClass.name}`);
        }
        const reachable = this.collectReachableModules(root, new Set());
        const modules = {};
        for (const moduleRef of reachable) {
            const moduleName = this.moduleName(moduleRef);
            if (this.ignoreImport.includes(moduleName)) {
                continue;
            }
            modules[moduleName] = {
                imports: [...moduleRef.imports.values()]
                    .map((m) => this.moduleName(m))
                    .filter((importName) => !this.ignoreImport.includes(importName)),
                exports: [...moduleRef.exports.values()]
                    .map((exportedItem) => this.wrapperName(exportedItem) || this.tokenName(exportedItem?.token || exportedItem))
                    .filter((exportName) => !!exportName && !this.ignoreProvider.includes(exportName)),
                providers: [...moduleRef.providers.values()]
                    .map((wrapper) => this.wrapperName(wrapper))
                    .filter((providerName) => !!providerName &&
                    !this.ignoreProvider.includes(providerName) &&
                    providerName !== moduleName),
                controllers: [...moduleRef.controllers.values()]
                    .map((w) => this.wrapperName(w))
                    .filter((controllerName) => !!controllerName),
            };
        }
        return {
            root: this.moduleName(root),
            modules,
        };
    }
    collectReachableModules(root, visited) {
        const id = this.moduleId(root);
        if (visited.has(id))
            return [];
        visited.add(id);
        const result = [root];
        for (const imported of root.imports.values()) {
            result.push(...this.collectReachableModules(imported, visited));
        }
        return result;
    }
    moduleName(moduleRef) {
        return moduleRef.metatype?.name || this.tokenName(moduleRef.token) || 'AnonymousModule';
    }
    moduleId(moduleRef) {
        return this.moduleName(moduleRef).replace(/[^a-zA-Z0-9_]/g, '_');
    }
    wrapperName(wrapper) {
        return (wrapper?.metatype?.name ||
            wrapper?.instance?.constructor?.name ||
            this.tokenName(wrapper?.token) ||
            null);
    }
    tokenName(token) {
        if (!token)
            return null;
        if (typeof token === 'string')
            return token;
        if (typeof token === 'symbol')
            return token.toString();
        if (typeof token === 'function')
            return token.name;
        return String(token);
    }
};
exports.ModuleGraphService = ModuleGraphService;
exports.ModuleGraphService = ModuleGraphService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [typeof (_a = typeof core_1.ModulesContainer !== "undefined" && core_1.ModulesContainer) === "function" ? _a : Object])
], ModuleGraphService);


/***/ }),

/***/ "./src/test1/test1.controller.ts":
/*!***************************************!*\
  !*** ./src/test1/test1.controller.ts ***!
  \***************************************/
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.Test1Controller = void 0;
const common_1 = __webpack_require__(/*! @nestjs/common */ "@nestjs/common");
let Test1Controller = class Test1Controller {
};
exports.Test1Controller = Test1Controller;
exports.Test1Controller = Test1Controller = __decorate([
    (0, common_1.Controller)('test1')
], Test1Controller);


/***/ }),

/***/ "./src/test1/test1.module.ts":
/*!***********************************!*\
  !*** ./src/test1/test1.module.ts ***!
  \***********************************/
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.Test1Module = void 0;
const common_1 = __webpack_require__(/*! @nestjs/common */ "@nestjs/common");
const test1_controller_1 = __webpack_require__(/*! ./test1.controller */ "./src/test1/test1.controller.ts");
const create_test1_usecase_1 = __webpack_require__(/*! ./usecases/create-test1.usecase */ "./src/test1/usecases/create-test1.usecase.ts");
let Test1Module = class Test1Module {
};
exports.Test1Module = Test1Module;
exports.Test1Module = Test1Module = __decorate([
    (0, common_1.Module)({
        providers: [create_test1_usecase_1.CreateTest1Usecase],
        controllers: [test1_controller_1.Test1Controller],
        exports: [create_test1_usecase_1.CreateTest1Usecase],
    })
], Test1Module);


/***/ }),

/***/ "./src/test1/usecases/create-test1.usecase.ts":
/*!****************************************************!*\
  !*** ./src/test1/usecases/create-test1.usecase.ts ***!
  \****************************************************/
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.CreateTest1Usecase = void 0;
const common_1 = __webpack_require__(/*! @nestjs/common */ "@nestjs/common");
let CreateTest1Usecase = class CreateTest1Usecase {
};
exports.CreateTest1Usecase = CreateTest1Usecase;
exports.CreateTest1Usecase = CreateTest1Usecase = __decorate([
    (0, common_1.Injectable)()
], CreateTest1Usecase);


/***/ }),

/***/ "@nestjs/common":
/*!*********************************!*\
  !*** external "@nestjs/common" ***!
  \*********************************/
/***/ ((module) => {

module.exports = require("@nestjs/common");

/***/ }),

/***/ "@nestjs/core":
/*!*******************************!*\
  !*** external "@nestjs/core" ***!
  \*******************************/
/***/ ((module) => {

module.exports = require("@nestjs/core");

/***/ }),

/***/ "reflect-metadata":
/*!***********************************!*\
  !*** external "reflect-metadata" ***!
  \***********************************/
/***/ ((module) => {

module.exports = require("reflect-metadata");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be isolated against other modules in the chunk.
(() => {
var exports = __webpack_exports__;
/*!*********************!*\
  !*** ./src/main.ts ***!
  \*********************/

Object.defineProperty(exports, "__esModule", ({ value: true }));
const core_1 = __webpack_require__(/*! @nestjs/core */ "@nestjs/core");
const app_module_1 = __webpack_require__(/*! ./app.module */ "./src/app.module.ts");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    await app.listen(process.env.PORT ?? 9999);
}
bootstrap();

})();

/******/ })()
;