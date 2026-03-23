import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { CreateUserUsecase } from './user/usecases/create-user.usecase';
import { ModuleRef } from '@nestjs/core';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly moduleRef: ModuleRef,
    private readonly createTest1Usecase: CreateUserUsecase,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
