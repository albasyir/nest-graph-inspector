import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { CreateTest1Usecase } from './test1/usecases/create-test1.usecase';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly createTest1Usecase: CreateTest1Usecase,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
