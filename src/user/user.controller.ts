import { Body, Controller, Post } from '@nestjs/common';
import { CreateUserUsecase } from './usecases/create-user.usecase';

@Controller('user')
export class UserController {
  constructor(private readonly createUserUsecase: CreateUserUsecase) {}

  @Post()
  createUser(@Body() body: unknown) {
    return this.createUserUsecase.execute(body);
  }
}
