import { Injectable } from '@nestjs/common';
import { UserRepository, User } from './user.repository';

@Injectable()
export class UserService {
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
}
