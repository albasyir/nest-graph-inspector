import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/** Starts the Shop App's REST API on port 8889. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(8889);
}

void bootstrap();
