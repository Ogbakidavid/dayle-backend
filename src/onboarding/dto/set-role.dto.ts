import { IsEnum, IsIn } from "class-validator";
import { UserRole } from "../../domain/enums";

export class SetRoleDto {
  @IsEnum(UserRole)
  @IsIn([UserRole.CLIENT, UserRole.FREELANCER])
  role: UserRole;
}
