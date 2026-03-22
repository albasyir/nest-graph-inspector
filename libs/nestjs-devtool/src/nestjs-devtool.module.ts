import { Module } from '@nestjs/common';
import { NestjsDevtoolService } from './nestjs-devtool.service';

@Module({
  providers: [NestjsDevtoolService],
  exports: [NestjsDevtoolService],
})
export class NestjsDevtoolModule {}
