import { ApiProperty } from '@nestjs/swagger';

export class UserResponse {
  @ApiProperty({ example: 'f5df2a66-119c-45e5-b797-fd31cfd93aa8' })
  id!: string;

  @ApiProperty({ example: 'manager@fnb.local' })
  email!: string;

  @ApiProperty({ example: 'ACTIVE', enum: ['ACTIVE', 'DISABLED'] })
  status!: string;

  @ApiProperty({ example: ['HQ_MENU_MANAGER'], type: [String] })
  roleCodes!: string[];

  @ApiProperty({ example: '2026-11-20T04:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-11-20T04:00:00.000Z' })
  updatedAt!: string;
}

export class RoleResponse {
  @ApiProperty({ example: '0c9d0f0e-2fa2-4f71-a111-6e2f83d94d02' })
  id!: string;

  @ApiProperty({ example: 'HQ_MENU_MANAGER' })
  code!: string;

  @ApiProperty({ example: 'HQ Menu Manager' })
  name!: string;

  @ApiProperty({ example: ['menu.read', 'menu.write'], type: [String] })
  permissions!: string[];
}
