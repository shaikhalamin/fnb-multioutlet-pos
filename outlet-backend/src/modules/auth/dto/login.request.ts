import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginRequest {
  @ApiProperty({ example: 'cashier@outlet-a.local', description: 'Outlet user email.' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Cashier123!', description: 'Outlet user password.', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
