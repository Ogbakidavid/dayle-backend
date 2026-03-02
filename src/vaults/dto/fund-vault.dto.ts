import { IsEnum, IsObject, IsUUID, IsOptional } from 'class-validator';

export class FundVaultDto {
  @IsEnum(['card', 'bank'])
  paymentMethod: 'card' | 'bank';

  @IsObject()
  @IsOptional()
  paymentDetails: any;

  @IsUUID()
  idempotencyKey: string;
}
