import { HttpException, type HttpExceptionBody } from '@nestjs/common';

export interface ApiExceptionPayload extends HttpExceptionBody {
  code: string;
  details?: Record<string, unknown>;
}

/**
 * HTTP exception carrying one of the stable error codes from PRD §12 so the
 * global filter can render the `ApiError` envelope without guessing.
 */
export class ApiException extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, status);
  }
}
