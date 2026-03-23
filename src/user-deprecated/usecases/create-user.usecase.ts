import { Injectable } from '@nestjs/common';

@Injectable()
export class CreateUserUsecase {
  execute(data: unknown) {
    return {
      message: 'User created',
      data,
    };
  }
}
