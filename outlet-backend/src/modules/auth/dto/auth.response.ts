import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AuthUserResponse {
  @ApiProperty({ example: 'f5df2a66-119c-45e5-b797-fd31cfd93aa8' })
  id!: string;

  @ApiProperty({ example: 'cashier@outlet-a.local' })
  email!: string;

  @ApiProperty({ example: ['OUTLET_CASHIER'] })
  roleCodes!: string[];

  @ApiProperty({ example: ['menu.read', 'sales.create', 'sales.read'] })
  permissions!: string[];

  @ApiProperty({
    example: '61de28db-92ed-46ef-9d90-3a951ac03420',
    description: 'Provisioned outlet this account belongs to.',
  })
  outletId!: string;
}

export class AuthResponse {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIs…', description: 'Short-lived HS256 access JWT.' })
  accessToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ example: 900, description: 'Access token lifetime in seconds.' })
  expiresInSeconds!: number;

  @ApiProperty({ type: AuthUserResponse })
  user!: AuthUserResponse;
}

export class RefreshResponse extends AuthResponse {}

export class LogoutResponse {
  @ApiProperty({ example: true })
  success!: boolean;
}

/** Reusable 401 body for the auth endpoints. */
export class UnauthorizedErrorResponse {
  @ApiProperty({ example: 'UNAUTHENTICATED' })
  code!: string;
}

export class RateLimitedErrorResponse {
  @ApiProperty({ example: 'RATE_LIMITED' })
  code!: string;
}

export class AuthErrorResponse {
  @ApiProperty({ example: 'VALIDATION_FAILED' })
  code!: string;

  @ApiPropertyOptional({ example: 'Request validation failed.' })
  message!: string;
}
