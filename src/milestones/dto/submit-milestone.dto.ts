import {
  IsString,
  IsArray,
  IsUrl,
  IsOptional,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class SubmissionFileDto {
  @IsString()
  name: string;

  @IsString()
  size: string;

  @IsString()
  @IsOptional()
  tag?: string;

  @IsUrl()
  @IsOptional()
  url?: string;
}

export class SubmitMilestoneDto {
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubmissionFileDto)
  @IsOptional()
  filesJson?: SubmissionFileDto[];

  @IsUrl()
  @IsOptional()
  url?: string;

  @IsUrl()
  @IsOptional()
  fileUrl?: string;
}