import { IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';

export class RefundMilestoneDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsUUID()
  milestoneId: string;

  @IsUUID()
  idempotencyKey: string;
}
