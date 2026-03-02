import { IsEnum, IsString, IsOptional, MaxLength } from 'class-validator';
import { VaultStatus } from '../../domain/enums';

export class UpdateVaultStatusDto {
  @IsEnum([VaultStatus.CANCELLED])
  status: VaultStatus;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  reason?: string;
}
