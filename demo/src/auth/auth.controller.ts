import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import type { SessionPrincipal } from '../common/authenticated-request';
import { CurrentSession } from '../common/current-customer.decorator';
import { Public } from '../common/public.decorator';
import type { Customer } from '../customer/customer.dto';
import {
  parseRegistration,
  parseSignInCredentials,
  type SessionToken,
} from './auth.dto';
import { AuthService } from './auth.service';

/** Registering, signing in and out, and checking a token. */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** `POST /auth/register` — open an account. */
  @Public()
  @Post('register')
  register(@Body() body: unknown): Promise<Customer> {
    return this.authService.register(parseRegistration(body));
  }

  /** `POST /auth/login` — sign in; answers with a bearer token. */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() body: unknown): Promise<SessionToken> {
    return this.authService.login(parseSignInCredentials(body));
  }

  /** `GET /auth/session` — whose token this is, and until when it is valid. */
  @Get('session')
  getSession(@CurrentSession() session: SessionPrincipal): SessionPrincipal {
    return session;
  }

  /** `POST /auth/logout` — end this session. */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@CurrentSession() session: SessionPrincipal): Promise<void> {
    return this.authService.logout(session.sessionId);
  }
}
