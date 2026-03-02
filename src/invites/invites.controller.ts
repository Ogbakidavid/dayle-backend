import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import { InvitesService } from './invites.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { RespondInviteDto } from './dto/respond-invite.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { User } from '../common/decorators/user.decorator';
import { UserRole } from '../domain/enums';
import { Public } from '../common/decorators/public.decorator';

@Controller('invites')
export class InvitesController {
  constructor(private readonly invitesService: InvitesService) {}

  @Post()
  @Roles(UserRole.CLIENT)
  async create(@Body() dto: CreateInviteDto, @User('id') userId: string) {
    return this.invitesService.create(dto, userId);
  }

  @Public()
  @Get('token/:token')
  async getByToken(@Param('token') token: string) {
    return this.invitesService.getByToken(token);
  }

  @Get('my-invites')
  @Roles(UserRole.FREELANCER, UserRole.NONE)
  async getMyInvites(@User('email') email: string) {
    return this.invitesService.listPendingByEmail(email);
  }

  @Get('vault/:vaultId')
  @Roles(UserRole.CLIENT)
  async getByVaultId(
    @Param('vaultId') vaultId: string,
    @User('id') userId: string,
  ) {
    return this.invitesService.getByVaultId(vaultId, userId);
  }

  @Post(':token/respond')
  @Roles(UserRole.FREELANCER, UserRole.NONE)
  async respond(
    @Param('token') token: string,
    @Body() dto: RespondInviteDto,
    @User('id') userId: string,
    @User('email') email: string,
  ) {
    return this.invitesService.respond(token, dto, userId, email);
  }
}
