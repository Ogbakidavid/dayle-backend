import { IsEmail, IsNotEmpty } from 'class-validator';

export class UpdateFreelancerDto {
  @IsEmail()
  @IsNotEmpty()
  freelancerEmail: string;
}
