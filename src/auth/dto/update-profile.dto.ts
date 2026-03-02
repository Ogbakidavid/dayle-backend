import {
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  IsUrl,
} from 'class-validator';

export class UpdateProfileDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @IsUrl()
  @IsOptional()
  profileImage?: string;
}
