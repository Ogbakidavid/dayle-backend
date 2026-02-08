import { IsUUID, IsEnum, IsString, MinLength, MaxLength, IsOptional } from "class-validator";
import { DisputeType, UserRole } from "../../domain/enums";

export class CreateDisputeDto {
  @IsUUID()
  vaultId: string;

  @IsUUID()
  milestoneId: string;

  @IsUUID()
  @IsOptional()
  requirementRef?: string;

  @IsEnum(DisputeType)
  disputeType: DisputeType;

  @IsString()
  reasonCode: string;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  description: string;
}
