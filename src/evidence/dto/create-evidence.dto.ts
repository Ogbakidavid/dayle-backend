import { IsUUID, IsEnum, IsObject, IsOptional } from "class-validator";
import { EvidenceType } from "../../domain/enums";

export class CreateEvidenceDto {
  @IsUUID()
  vaultId: string;

  @IsUUID()
  @IsOptional()
  milestoneId?: string;

  @IsEnum(EvidenceType)
  type: EvidenceType;

  @IsUUID()
  @IsOptional()
  disputeId?: string;

  @IsObject()
  payload: {
    content: string;
    filesJson?: string;
    supersedesEventId?: string;
  };
}
