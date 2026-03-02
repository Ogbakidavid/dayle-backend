import { IsString, IsNotEmpty, IsOptional, IsArray } from 'class-validator';

export class SubmitVaultDto {
  @IsArray()
  @IsOptional()
  files?: Array<{ name: string; size: number }>;

  @IsString()
  @IsOptional()
  comments?: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;
}
