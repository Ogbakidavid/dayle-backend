import {
  IsString,
  IsNumber,
  IsArray,
  IsEnum,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsDateString,
  MinLength,
  MaxLength,
  Min,
  ArrayMinSize,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { VaultType, MilestoneDeliverableMode } from "../../domain/enums";

export class RequirementItemDto {
  @IsString()
  reqId: string;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  label: string;

  @IsBoolean()
  @IsOptional()
  required?: boolean;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  acceptance?: string;
}

export class CreateMilestoneDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @IsString()
  @IsOptional()
  deliverableTypeId?: string;

  @IsEnum(MilestoneDeliverableMode)
  @IsOptional()
  deliverableMode?: MilestoneDeliverableMode;

  @IsBoolean()
  @IsOptional()
  auditEnabled?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RequirementItemDto)
  @IsOptional()
  requirementItemsJson?: RequirementItemDto[];
}

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

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateMilestoneDto)
  @ArrayMinSize(1)
  milestones: CreateMilestoneDto[];

  @IsUUID()
  @IsOptional()
  idempotencyKey?: string;
}