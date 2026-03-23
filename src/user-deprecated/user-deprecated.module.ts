import { Module } from '@nestjs/common';
import { UserDeprecatedController } from './user-deprecated.controller';
import { UserDeprecatedService } from './user-deprecated.service';
import { CreateUserUsecase } from './usecases/create-user.usecase';

@Module({
  controllers: [UserDeprecatedController],
  providers: [UserDeprecatedService, CreateUserUsecase],
  exports: [CreateUserUsecase],
})
export class UserDeprecatedModule {}
