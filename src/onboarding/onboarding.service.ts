import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SetRoleDto } from "./dto/set-role.dto";
import { SubmitKycDto } from "./dto/submit-kyc.dto";
import { UserRole, KycStatus } from "../domain/enums";

@Injectable()
export class OnboardingService {
  constructor(private prisma: PrismaService) {}

  async setRole(userId: string, dto: SetRoleDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException("User not found");
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
      throw new NotFoundException("User not found");
    }

    if (user.role === UserRole.NONE) {
      throw new BadRequestException({
        code: "ROLE_NOT_SET",
        message: "Must set role first",
      });
    }

    if (user.kycStatus === KycStatus.VERIFIED) {
      throw new BadRequestException({
        code: "KYC_ALREADY_VERIFIED",
        message: "KYC already verified",
      });
    }

    // Construct fields if missing from request but required by DB
    const fullName =
      dto.fullName ||
      (dto.firstName && dto.lastName
        ? `${dto.firstName} ${dto.lastName}`
        : dto.firstName || dto.lastName || "Unknown User");

    const address = dto.address || dto.country || "Address not provided";
    const idDocumentUrl = dto.idDocumentUrl || "https://placeholder.com/id.jpg";

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
      throw new NotFoundException("User not found");
    }

    return {
      roleSet: user.role !== UserRole.NONE,
      kycVerified: user.kycStatus === KycStatus.VERIFIED,
      emailVerified: user.emailVerified,
    };
  }

  private sanitizeUser(user: any) {
    const { passwordHash, updatedAt, ...result } = user;
    return result;
  }
}
