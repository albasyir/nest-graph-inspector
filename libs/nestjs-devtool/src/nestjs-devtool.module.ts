import { Module } from '@nestjs/common';
import { ConfigurableModuleClass } from './nestjs-devtool.config';
import { NestJSDevtoolService } from './nestjs-devtool.service';

@Module({
  providers: [NestJSDevtoolService],
  exports: [NestJSDevtoolService],
})
export class NestjsDevtoolModule extends ConfigurableModuleClass {}
