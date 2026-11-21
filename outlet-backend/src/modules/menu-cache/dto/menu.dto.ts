import { ApiProperty } from '@nestjs/swagger';

export class OutletMenuItemResponse {
  @ApiProperty({
    example: '9708835e-2e21-465a-87e9-5f8d56cd44ab',
    description: 'HQ master-menu-item UUID (local catalog key).',
  })
  menuItemId!: string;

  @ApiProperty({ example: 'BURGER-01' })
  sku!: string;

  @ApiProperty({ example: 'Chicken Burger' })
  name!: string;

  @ApiProperty({ example: 'Grilled chicken burger' })
  description!: string;

  @ApiProperty({ example: 'Burgers' })
  category!: string;

  @ApiProperty({
    example: '1200',
    description: 'Effective outlet price, integer minor units, decimal string.',
  })
  unitPriceMinor!: string;

  @ApiProperty({ example: 'USD' })
  currencyCode!: string;

  @ApiProperty({ example: 30, description: 'On-hand quantity; 0 when no balance row exists.' })
  availableQuantity!: number;
}
