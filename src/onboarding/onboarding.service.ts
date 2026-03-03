import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SetRoleDto } from './dto/set-role.dto';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { UserRole, KycStatus } from '../domain/enums';
import { DiditService } from '../common/services/didit.service';

@Injectable()
export class OnboardingService {
  constructor(
    private prisma: PrismaService,
    private diditService: DiditService,
  ) {}

  async setRole(userId: string, dto: SetRoleDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { role: dto.role },
    });

    return this.sanitizeUser(updatedUser);
  }

  async submitKyc(userId: string, dto: SubmitKycDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { kycData: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === UserRole.NONE) {
      throw new BadRequestException({
        code: 'ROLE_NOT_SET',
        message: 'Must set role first',
      });
    }

    if (user.kycStatus === KycStatus.VERIFIED) {
      throw new BadRequestException({
        code: 'KYC_ALREADY_VERIFIED',
        message: 'KYC already verified',
      });
    }

    // Construct fields if missing from request but required by DB
    const fullName =
      dto.fullName ||
      (dto.firstName && dto.lastName
        ? `${dto.firstName} ${dto.lastName}`
        : dto.firstName || dto.lastName || 'Unknown User');

    const address = dto.address || dto.country || 'Address not provided';
    const idDocumentUrl = dto.idDocumentUrl || 'https://placeholder.com/id.jpg';

    // Update kycStatus and create/update kycData
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        kycStatus: KycStatus.PENDING,
        kycData: {
          upsert: {
            create: {
              fullName: fullName,
              dateOfBirth: new Date(dto.dateOfBirth),
              address: address,
              idDocumentUrl: idDocumentUrl,
              proofOfAddressUrl: dto.proofOfAddressUrl,
              idType: dto.idType,
              idNumber: dto.idNumber,
            },
            update: {
              fullName: fullName,
              dateOfBirth: new Date(dto.dateOfBirth),
              address: address,
              idDocumentUrl: idDocumentUrl,
              proofOfAddressUrl: dto.proofOfAddressUrl,
              idType: dto.idType,
              idNumber: dto.idNumber,
            },
          },
        },
      },
    });

    return this.sanitizeUser(updatedUser);
  }

  async getStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      roleSet: user.role !== UserRole.NONE,
      kycVerified: user.kycStatus === KycStatus.VERIFIED,
      emailVerified: user.emailVerified,
    };
  }

  async getDiditSession(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Usually, the frontend runs on localhost:3000 during dev.
    // Ideally this is dynamic, but we can hardcode for testing.
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const callbackUrl = `${baseUrl}/client/settings?didit=success`;

    // Securely acquire session from Didit passing the userId as vendor_data
    const sessionResponse = await this.diditService.createSession(
      userId,
      callbackUrl,
    );

    // Update status to pending if they start a session
    await this.prisma.user.update({
      where: { id: userId },
      data: { kycStatus: KycStatus.PENDING },
    });

    return {
      sessionId: sessionResponse.session_id,
      url: sessionResponse.url,
    };
  }

  private sanitizeUser(user: any) {
    const { passwordHash, updatedAt, ...result } = user;
    return result;
  }
}
