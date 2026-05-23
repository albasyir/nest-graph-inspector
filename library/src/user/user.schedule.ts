import { Injectable } from "@nestjs/common";
import { UserRepository } from "./user.repository";

/**
 * scheduler for user module
 */
@Injectable()
export class UserSchedule {
    constructor(
        private readonly userService: UserRepository
    ) {}

    reward() {
        this.userService.findById(1);
        console.log('rewarding user');
    }
}