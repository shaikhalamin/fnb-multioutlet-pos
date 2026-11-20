import { BadRequestException, ValidationPipe, type ValidationError } from '@nestjs/common';

function flatten(error: ValidationError): Record<string, unknown> {
  return {
    property: error.property,
    ...(error.constraints ? { constraints: Object.values(error.constraints) } : {}),
    ...(error.children && error.children.length > 0
      ? { children: error.children.map(flatten) }
      : {}),
  };
}

/**
 * Global ValidationPipe per PRD §5: whitelist + reject unknown fields +
 * transform, mapping failures onto the `VALIDATION_FAILED` error code.
 */
export function makeGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        details: { errors: errors.map(flatten) },
      }),
  });
}
