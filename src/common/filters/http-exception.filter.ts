import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // Debug log for 500 errors
    console.error('Exception caught by filter:', exception);

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
        message = exceptionResponse as string;
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

    response.status(status).json({
      code,
      message,
      details,
      statusCode: status,
    });
  }
}
