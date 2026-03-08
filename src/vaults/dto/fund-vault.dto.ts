import { IsEnum, IsObject, IsUUID, IsOptional } from 'class-validator';

export class FundVaultDto {
  @IsEnum(['card', 'bank'])
  paymentMethod: 'card' | 'bank';

  @IsObject()
  @IsOptional()
  paymentDetails: any;

  @IsEnum(['USD', 'NGN'])
  @IsOptional()
  currency?: 'USD' | 'NGN';

  @IsOptional()
  idempotencyKey?: string;
}
