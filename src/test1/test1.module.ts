import { Module } from '@nestjs/common';
import { Test1Controller } from './test1.controller';
import { CreateTest1Usecase } from './usecases/create-test1.usecase';

@Module({
  providers: [CreateTest1Usecase],
  controllers: [Test1Controller],
  exports: [CreateTest1Usecase],
})
export class Test1Module {}
