import { Controller, Get, Inject } from '@nestjs/common';
import { AppService } from './app.service';
import { CreateUserUsecase } from './user/usecases/create-user.usecase';
import { ModuleRef } from '@nestjs/core';

@Controller()
export class AppController {
  @Inject(CreateUserUsecase)
  private readonly test1: CreateUserUsecase;

  constructor(
    private readonly appService: AppService,
    private readonly moduleRef: ModuleRef,
  ) { }

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
