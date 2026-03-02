import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  IsUUID,
  MaxLength,
  MinLength,
  Min,
} from 'class-validator';
import { VaultType } from '../../domain/enums';

export class CreateVaultDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title: string;

  @IsString()
  @MaxLength(1000)
  @IsOptional()
  description?: string;

  @IsEnum(VaultType)
  type: VaultType;

  @IsNumber()
  @Min(1)
  totalAmount: number;

  @IsUUID()
  @IsOptional()
  idempotencyKey?: string;

  @IsString()
  @IsOptional()
  vaultAddress?: string;

  @IsString()
  @IsOptional()
  freelancerEmail?: string;
}
