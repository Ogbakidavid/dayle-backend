import {
  IsString,
  IsEnum,
  IsOptional,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { DisputeType } from '../../domain/enums';

export class CreateDisputeDto {
  @IsUUID()
  vaultId: string;

  @IsString()
  @IsOptional()
  requirementRef?: string;

  @IsEnum(DisputeType)
  disputeType: DisputeType;

  @IsString()
  reasonCode: string;

  @IsString()
  @MaxLength(1000)
  description: string;
}
