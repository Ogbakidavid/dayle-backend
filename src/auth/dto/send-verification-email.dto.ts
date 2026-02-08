import { IsEmail } from 'class-validator';

export class SendVerificationEmailDto {
  @IsEmail()
  email: string;
}
