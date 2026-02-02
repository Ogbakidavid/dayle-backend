import { IsUUID } from "class-validator";

export class ReleaseMilestoneDto {
  @IsUUID()
  milestoneId: string;

  @IsUUID()
  idempotencyKey: string;
}