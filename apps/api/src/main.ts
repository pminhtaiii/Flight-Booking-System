import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  try {
    const app = await NestFactory.create(AppModule);

    const expressApp = app.getHttpAdapter().getInstance();
    expressApp.set('trust proxy', 'loopback, link-local, 127.0.0.1, ::1');

    // 1. CORS Configuration
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    app.enableCors({
      origin: frontendUrl,
      credentials: true,
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    });

    // 2. Global Validation Pipe
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    // 3. Set Global URL Path Prefix
    app.setGlobalPrefix('api', { exclude: ['health'] });

    // Enable shutdown hooks to run OnModuleDestroy
    app.enableShutdownHooks();

    // 4. Register Global HTTP Exception Filter
    app.useGlobalFilters(new HttpExceptionFilter());

    const port = process.env.PORT || 3001;
    await app.listen(port);
    logger.log(`API application running on: http://localhost:${port}/api`);
  } catch (error) {
    logger.error('Error bootstrapping NestJS application:', error);
    process.exit(1);
  }
}

bootstrap();
