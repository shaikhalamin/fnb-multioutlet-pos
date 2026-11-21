import { ApiProperty } from '@nestjs/swagger';

export class DependencyStatusResponse {
  @ApiProperty({ example: 'up', enum: ['up', 'down'] })
  status!: 'up' | 'down';

  @ApiProperty({
    example: 'Connection refused',
    type: String,
    nullable: true,
    required: false,
    description: 'Failure reason when the check is down.',
  })
  reason?: string | null;
}

export class HealthChecksResponse {
  @ApiProperty({ type: DependencyStatusResponse })
  database!: DependencyStatusResponse;

  @ApiProperty({ type: DependencyStatusResponse })
  redis!: DependencyStatusResponse;
}

export class HealthResponse {
  @ApiProperty({ example: 'ok', enum: ['ok', 'down'] })
  status!: 'ok' | 'down';

  @ApiProperty({ example: 'outlet-backend' })
  service!: string;

  @ApiProperty({ example: '0.1.0' })
  version!: string;

  @ApiProperty({ example: 120 })
  uptimeSeconds!: number;

  @ApiProperty({ example: '2026-11-20T19:43:03.720Z' })
  timestamp!: string;

  @ApiProperty({ type: HealthChecksResponse })
  checks!: HealthChecksResponse;
}
