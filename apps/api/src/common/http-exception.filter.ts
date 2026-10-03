import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, body } = this.translate(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { err: exception, path: request.url, method: request.method },
        'Unhandled exception',
      );
    } else {
      this.logger.debug(
        { path: request.url, method: request.method, status, message: body.message, errors: body.errors },
        'Request rejected',
      );
    }

    response.status(status).json({ ...body, statusCode: status, path: request.url });
  }

  private translate(exception: unknown): { status: number; body: Record<string, unknown> } {
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      return {
        status: exception.getStatus(),
        body: typeof payload === 'string' ? { message: payload } : (payload as Record<string, unknown>),
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            status: HttpStatus.CONFLICT,
            body: { message: 'That record already exists', code: 'DUPLICATE' },
          };
        case 'P2025':
          return {
            status: HttpStatus.NOT_FOUND,
            body: { message: 'Not found', code: 'NOT_FOUND' },
          };
        case 'P2003':
          return {
            status: HttpStatus.BAD_REQUEST,
            body: { message: 'Referenced record does not exist', code: 'FK_VIOLATION' },
          };
        default:
          break;
      }
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { message: 'Internal server error', code: 'INTERNAL' },
    };
  }
}
