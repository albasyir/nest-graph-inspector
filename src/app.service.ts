import { Injectable } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { CreateUserUsecase } from './user-deprecated/usecases/create-user.usecase';

@Injectable()
export class AppService {
  constructor(
    private readonly modulesContainer: ModulesContainer,
    private readonly createUserUsecase: CreateUserUsecase,
  ) {}

  getHello(): string {
    return 'Hello World!';
  }
}
