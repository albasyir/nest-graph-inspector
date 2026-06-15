import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { MobileService } from '../mobile/mobile.service';
import { UserRepository, User } from './user.repository';

@Injectable()
export class UserService {
  @Inject(forwardRef(() => MobileService))
  private readonly mobileService!: MobileService;

  constructor(private readonly userRepository: UserRepository) {}

  createUser(name: string, email: string): User {
    return this.userRepository.create(name, email);
  }

  getUserById(id: number): User | undefined {
    return this.userRepository.findById(id);
  }

  getAllUsers(): User[] {
    return this.userRepository.findAll();
  }

  getFeaturedMobileProductName(productId: number): string | undefined {
    return this.mobileService.getFeaturedProductName(productId);
  }
}
