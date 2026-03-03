import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  IsUUID,
  MaxLength,
  MinLength,
  Min,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
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

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => DeliverableDto)
  deliverables: DeliverableDto[];
}

export class DeliverableDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title: string;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;
}
