import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginRequest {
  @ApiProperty({ example: 'admin@fnb.local', description: 'HQ user email.' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Admin123!', description: 'HQ user password.', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
