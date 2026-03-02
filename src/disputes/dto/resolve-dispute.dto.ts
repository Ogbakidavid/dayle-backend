import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export enum DisputeResolutionOutcome {
  RELEASE = 'RELEASE',
  REFUND = 'REFUND',
  SPLIT = 'SPLIT',
}

export class ResolveDisputeDto {
  @IsEnum(DisputeResolutionOutcome)
  outcome: DisputeResolutionOutcome;

  @IsNumber()
  @Min(0.01)
  @IsOptional()
  splitAmount?: number; // amount to release to freelancer if SPLIT

  @IsString()
  notes: string;
}
