import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { PasswordHasher } from './password-hasher';
import { CustomerModule } from '../customer/customer.module';

/**
 * Accounts, sessions, and the global AuthGuard that makes every route private
 * unless it is marked `@Public()`. Imports CustomerModule to create the
 * customer behind an account and find them again at sign-in.
 */
@Module({
  imports: [CustomerModule],
  controllers: [AuthController],
  providers: [
    AuthRepository,
    AuthService,
    PasswordHasher,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
