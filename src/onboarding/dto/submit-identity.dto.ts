import {
  IsString,
  IsNotEmpty,
  Matches,
  ValidateIf,
  Length,
} from 'class-validator';

export class SubmitIdentityDto {
  @IsString()
  @IsNotEmpty()
  country: string;

  @ValidateIf((o) => o.country === 'NG' || o.country === 'NGA')
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{11}$/, { message: 'BVN must be exactly 11 digits.' })
  bvn?: string;

  @ValidateIf((o) => o.country === 'KE' || o.country === 'KEN')
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+254\d{9}$/, {
    message:
      'Kenyan phone number must be in +254xxxxxxxxx format (9 digits after code).',
  })
  phoneNumber?: string;
}
