import { IsEnum, IsObject, IsOptional } from 'class-validator';

export class FundVaultDto {
  @IsEnum(['bank'])
  paymentMethod: 'bank';

  @IsObject()
  @IsOptional()
  paymentDetails: any;

  @IsEnum(['USD', 'NGN', 'KES'])
  @IsOptional()
  currency?: 'USD' | 'NGN' | 'KES';

  @IsOptional()
  rateKey?: string;

  @IsOptional()
  amount?: number;

  @IsOptional()
  idempotencyKey?: string;
}
