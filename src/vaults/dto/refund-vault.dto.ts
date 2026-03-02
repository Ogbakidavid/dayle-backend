import { IsOptional, IsUUID } from 'class-validator';

export class RefundVaultDto {
  @IsUUID()
  @IsOptional()
  idempotencyKey?: string;
}
