import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { CreateUserUsecase } from './user-deprecated/usecases/create-user.usecase';
import { ModuleRef } from '@nestjs/core';

@Injectable()
export class AppService {
  constructor(
    private readonly moduleRef: ModuleRef,

    @Inject(CreateUserUsecase)
    private readonly createUserUsecase: any,
  ) { }

  getHello(): string {
    return 'Hello World!';
  }
}
