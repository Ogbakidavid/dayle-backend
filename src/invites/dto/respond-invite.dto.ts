import { IsEnum, IsString, MaxLength, IsOptional } from 'class-validator';

export class RespondInviteDto {
  @IsEnum(['accept', 'decline'])
  action: 'accept' | 'decline';

  @IsString()
  @MaxLength(500)
  @IsOptional()
  declineReason?: string;
}
