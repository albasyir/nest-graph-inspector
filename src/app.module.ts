import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UserModule } from './user/user.module';
import { NestjsDevtoolModule } from 'nestjs-devtool/nestjs-devtool';
import { UserDeprecatedModule } from './user-deprecated/user-deprecated.module';

@Module({
  imports: [
    UserModule,
    NestjsDevtoolModule.forRootAsync({
      useFactory() {
        return {
          rootModule: AppModule,
          output: {
            file: 'tmp/graph-output.md',
          },
        };
      },
    }),
    UserDeprecatedModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
