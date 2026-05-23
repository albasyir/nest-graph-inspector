import { forwardRef, Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { UserRepository } from './user.repository';
import { MobileModule } from '../mobile/mobile.module';
import { UserSchedule } from './user.schedule';

@Module({
  imports: [forwardRef(() => MobileModule)],
  controllers: [UserController],
  providers: [UserService, UserRepository, UserSchedule],
  exports: [UserService],
})
export class UserModule {}
