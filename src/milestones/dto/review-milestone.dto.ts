import {
  IsEnum,
  IsArray,
  IsString,
  IsOptional,
  MaxLength,
} from "class-validator";
import { MilestoneReviewOutcome } from "../../domain/enums";

export class ReviewMilestoneDto {
  @IsEnum(MilestoneReviewOutcome)
  outcome: MilestoneReviewOutcome;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  reasonCodes?: string[];

  @IsString()
  @MaxLength(1000)
  @IsOptional()
  notes?: string;
}