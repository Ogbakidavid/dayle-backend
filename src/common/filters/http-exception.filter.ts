import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response, Request } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected error occurred';
    let details: any = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as any;
        code = resp.code || resp.error || 'ERROR';
        message = resp.message || exception.message;
        details = resp.details;
      } else {
        message = exceptionResponse;
      }
    } else if (exception && (exception as any).status) {
      // Fallback for cases where instanceof fails but it looks like an HttpException
      status = (exception as any).status;
      const resp = (exception as any).response;
      if (resp && typeof resp === 'object') {
        code = resp.code || resp.error || 'ERROR';
        message = resp.message || message;
      }
    }

    // Structured logging: log 5xx as errors, skip noisy 4xx in production
    const isServerError = status >= 500;
    const isDev = process.env.NODE_ENV !== 'production';

    if (isServerError) {
      this.logger.error(
        `[${status}] ${request.method} ${request.url} — ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (isDev) {
      this.logger.warn(
        `[${status}] ${request.method} ${request.url} — ${code}: ${message}`,
      );
    }

    const responseBody = {
      code,
      message,
      details,
      statusCode: status,
    };

    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        Object.assign(responseBody, exceptionResponse);
      }
    }

    response.status(status).json(responseBody);
  }
}
