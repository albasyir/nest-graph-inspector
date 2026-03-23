import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UserModule } from './user/user.module';
import { NestGraphInspectorModule } from 'nest-graph-inspector/nest-graph-inspector';
import { UserDeprecatedModule } from './user-deprecated/user-deprecated.module';

@Module({
  imports: [
    /**
     * Nest Graph Inspector
     *
     */
    NestGraphInspectorModule.forRoot({
      rootModule: AppModule,
      output: {
        file: 'src/graph-output.md',
      },
    }),

    UserModule,
    UserDeprecatedModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
