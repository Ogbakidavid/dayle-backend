import { IsEnum, IsString, IsOptional, IsNumber, Min } from "class-validator";

export enum DisputeResolutionOutcome {
  RELEASE = "RELEASE",
  REFUND = "REFUND",
  SPLIT = "SPLIT",
}

export class ResolveDisputeDto {
  @IsEnum(DisputeResolutionOutcome)
  outcome: DisputeResolutionOutcome;

  @IsString()
  notes: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  splitAmount?: number; // Used only for SPLIT outcome
}
