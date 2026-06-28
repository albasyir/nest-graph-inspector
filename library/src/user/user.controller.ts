import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { UserService } from './user.service';
import { UserSchedule } from './user.schedule';

@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService, 
    private readonly userSchedule: UserSchedule
  ) {}

  @Post()
  createUser(@Body() body: { name: string; email: string }) {
    this.userSchedule.reward();
    return this.userService.createUser(body);
  }

  @Get()
  getAllUsers() {
    return this.userService.getAllUsers();
  }

  @Get(':id')
  getUserById(@Param('id') id: string) {
    return this.userService.getUserById(Number(id));
  }
}
