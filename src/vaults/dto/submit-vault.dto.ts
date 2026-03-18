import { IsString, IsNotEmpty, IsOptional, IsArray, ValidateNested, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';

export class DeliverableStatusDto {
  @IsString()
  @IsNotEmpty()
  deliverableId: string;

  @IsBoolean()
  included: boolean;

  @IsString()
  @IsNotEmpty()
  notes: string;

  @IsArray()
  @IsOptional()
  files?: Array<{ name: string; size: number }>;

  @IsString()
  @IsOptional()
  link?: string;
}

export class SubmitVaultDto {
  @IsArray()
  @IsOptional()
  files?: Array<{ name: string; size: number }>;

  @IsString()
  @IsNotEmpty()
  comments: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => DeliverableStatusDto)
  deliverableStatus?: DeliverableStatusDto[];

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;
}
