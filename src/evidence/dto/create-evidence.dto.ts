import {
  IsString,
  IsEnum,
  IsOptional,
  IsUUID,
  IsObject,
} from 'class-validator';
import { EvidenceType } from '../../domain/enums';

export class CreateEvidenceDto {
  @IsUUID()
  vaultId: string;

  @IsUUID()
  @IsOptional()
  disputeId?: string;

  @IsEnum(EvidenceType)
  type: EvidenceType;

  @IsObject()
  payload: Record<string, any>;
}
