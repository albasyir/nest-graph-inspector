import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { CreateUserUsecase } from './usecases/create-user.usecase';
import { UserDeprecatedModule } from 'src/user-deprecated/user-deprecated.module';

@Module({
  imports: [UserDeprecatedModule],
  providers: [CreateUserUsecase],
  controllers: [UserController],
  exports: [CreateUserUsecase],
})
export class UserModule {}
