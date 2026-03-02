import { IsOptional, IsUUID } from 'class-validator';

export class ReleaseVaultDto {
  @IsUUID()
  @IsOptional()
  idempotencyKey?: string;
}
