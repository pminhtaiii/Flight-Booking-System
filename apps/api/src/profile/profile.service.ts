import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { EncryptionService } from '@/common/encryption.service';
import { AuditService } from '@/audit/audit.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileResponseDto } from './dto/profile-response.dto';

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  private checkFeatureEnabled() {
    const enabled = this.configService.get<string>('FEATURE_FLAG_BOOKING_READINESS') === 'true';
    if (!enabled) {
      throw new NotFoundException('FEATURE_DISABLED');
    }
  }

  private formatDate(date: Date | null | undefined): string | null {
    if (!date) return null;
    return date.toISOString().split('T')[0];
  }

  async getProfile(userId: string): Promise<ProfileResponseDto> {
    this.checkFeatureEnabled();

    const dbProfile = await this.prisma.travelerProfile.findUnique({
      where: { userId },
    });

    if (!dbProfile) {
      return {
        profileId: null,
        identity: null,
        contact: null,
        travelDocument: null,
        preferences: null,
        revision: 0,
      };
    }

    // 1. Decrypt passportNumber
    let decryptedPassport: string | null = null;
    if (dbProfile.passportNumber) {
      try {
        decryptedPassport = this.encryptionService.decryptBound(dbProfile.passportNumber, {
          userId,
          fieldName: 'passportNumber',
        });
      } catch (err) {
        try {
          decryptedPassport = this.encryptionService.decrypt(dbProfile.passportNumber);
        } catch {
          decryptedPassport = null;
        }
      }
    }

    // 2. Resolve passportExpiry via shadow read
    let decryptedExpiry: string | null = null;
    if (dbProfile.passportExpiryCiphertext) {
      try {
        decryptedExpiry = this.encryptionService.decryptBound(dbProfile.passportExpiryCiphertext, {
          userId,
          fieldName: 'passportExpiry',
        });
      } catch (err) {
        decryptedExpiry = null;
      }
    }

    const plainExpiryStr = this.formatDate(dbProfile.passportExpiry);
    let finalExpiry: string | null = null;

    if (dbProfile.passportExpiryCiphertext) {
      if (decryptedExpiry && plainExpiryStr && decryptedExpiry === plainExpiryStr) {
        finalExpiry = decryptedExpiry;
      } else {
        // Disagreement / safe integrity failure: do not expose either
        finalExpiry = null;
      }
    } else {
      finalExpiry = plainExpiryStr;
    }

    // 3. Map sections
    const hasIdentity =
      dbProfile.givenName ||
      dbProfile.middleName ||
      dbProfile.familyName ||
      dbProfile.dateOfBirth ||
      dbProfile.gender ||
      dbProfile.title;

    const identity = hasIdentity
      ? {
          givenName: dbProfile.givenName || null,
          middleName: dbProfile.middleName || null,
          familyName: dbProfile.familyName || null,
          dateOfBirth: this.formatDate(dbProfile.dateOfBirth),
          gender: dbProfile.gender || null,
          title: dbProfile.title || null,
        }
      : null;

    const hasContact = dbProfile.email || dbProfile.phoneCountryCode || dbProfile.phoneNumber;
    const contact = hasContact
      ? {
          email: dbProfile.email || null,
          phoneCountryCode: dbProfile.phoneCountryCode || null,
          phoneNumber: dbProfile.phoneNumber || null,
        }
      : null;

    const hasDoc =
      dbProfile.documentType ||
      decryptedPassport ||
      finalExpiry ||
      dbProfile.issuingCountry ||
      dbProfile.nationality;

    const travelDocument = hasDoc
      ? {
          documentType: dbProfile.documentType || null,
          passportNumber: decryptedPassport,
          passportExpiry: finalExpiry,
          issuingCountry: dbProfile.issuingCountry || null,
          nationality: dbProfile.nationality || null,
        }
      : null;

    const hasPrefs = dbProfile.seatPreference || dbProfile.classPreference;
    const preferences = hasPrefs
      ? {
          seatPreference: dbProfile.seatPreference || null,
          classPreference: dbProfile.classPreference || null,
        }
      : null;

    return {
      profileId: dbProfile.id,
      identity,
      contact,
      travelDocument,
      preferences,
      revision: dbProfile.revision,
      updatedAt: dbProfile.updatedAt ? dbProfile.updatedAt.toISOString() : undefined,
    };
  }

  async updateProfile(
    userId: string,
    updateDto: UpdateProfileDto,
    traceId?: string,
    correlationId?: string,
  ): Promise<ProfileResponseDto> {
    this.checkFeatureEnabled();

    const currentProfile = await this.prisma.travelerProfile.findUnique({
      where: { userId },
    });

    const data: any = {};

    // Map fields
    if (updateDto.identity !== undefined) {
      if (updateDto.identity === null) {
        data.givenName = null;
        data.middleName = null;
        data.familyName = null;
        data.dateOfBirth = null;
        data.gender = null;
        data.title = null;
      } else {
        data.givenName = updateDto.identity.givenName;
        data.middleName = updateDto.identity.middleName;
        data.familyName = updateDto.identity.familyName;
        data.dateOfBirth = new Date(updateDto.identity.dateOfBirth);
        data.gender = updateDto.identity.gender;
        data.title = updateDto.identity.title;
      }
    }

    if (updateDto.contact !== undefined) {
      if (updateDto.contact === null) {
        data.email = null;
        data.phoneCountryCode = null;
        data.phoneNumber = null;
      } else {
        data.email = updateDto.contact.email;
        data.phoneCountryCode = updateDto.contact.phoneCountryCode;
        data.phoneNumber = updateDto.contact.phoneNumber;
      }
    }

    if (updateDto.travelDocument !== undefined) {
      if (updateDto.travelDocument === null) {
        data.documentType = null;
        data.passportNumber = null;
        data.passportExpiry = null;
        data.passportExpiryCiphertext = null;
        data.issuingCountry = null;
        data.nationality = null;
      } else {
        data.documentType = updateDto.travelDocument.documentType;
        data.passportNumber = this.encryptionService.encryptBound(
          updateDto.travelDocument.passportNumber,
          { userId, fieldName: 'passportNumber' },
        );
        data.passportExpiry = new Date(updateDto.travelDocument.passportExpiry);
        data.passportExpiryCiphertext = this.encryptionService.encryptBound(
          updateDto.travelDocument.passportExpiry,
          { userId, fieldName: 'passportExpiry' },
        );
        data.issuingCountry = updateDto.travelDocument.issuingCountry;
        data.nationality = updateDto.travelDocument.nationality;
      }
    }

    if (updateDto.preferences !== undefined) {
      if (updateDto.preferences === null) {
        data.seatPreference = null;
        data.classPreference = null;
      } else {
        data.seatPreference = updateDto.preferences.seatPreference;
        data.classPreference = updateDto.preferences.classPreference;
      }
    }

    const changedFields: string[] = [];
    if (updateDto.identity !== undefined) changedFields.push('identity');
    if (updateDto.contact !== undefined) changedFields.push('contact');
    if (updateDto.travelDocument !== undefined) changedFields.push('travelDocument');
    if (updateDto.preferences !== undefined) changedFields.push('preferences');

    let updatedProfile: any;

    await this.prisma.$transaction(async (tx) => {
      if (!currentProfile) {
        // Upsert: profile doesn't exist
        if (updateDto.expectedRevision !== 0) {
          throw new ConflictException('PROFILE_UPDATE_CONFLICT');
        }

        data.userId = userId;
        data.revision = 1;

        try {
          updatedProfile = await tx.travelerProfile.create({
            data,
          });
        } catch (err: any) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw new ConflictException('PROFILE_UPDATE_CONFLICT');
          }
          if (err?.code === 'P2002') {
            throw new ConflictException('PROFILE_UPDATE_CONFLICT');
          }
          throw err;
        }

        await this.auditService.createLog(tx, {
          userId,
          action: 'create_profile',
          resourceType: 'TravelerProfile',
          resourceId: updatedProfile.id,
          traceId,
          correlationId,
          metadata: {
            changedFields,
            revision: 1,
          },
        });
      } else {
        // Exists: CAS revision check
        if (currentProfile.revision !== updateDto.expectedRevision) {
          throw new ConflictException('PROFILE_UPDATE_CONFLICT');
        }

        data.revision = { increment: 1 };

        try {
          updatedProfile = await tx.travelerProfile.update({
            where: { userId, revision: updateDto.expectedRevision },
            data,
          });
        } catch (err) {
          throw new ConflictException('PROFILE_UPDATE_CONFLICT');
        }

        await this.auditService.createLog(tx, {
          userId,
          action: 'update_profile',
          resourceType: 'TravelerProfile',
          resourceId: updatedProfile.id,
          traceId,
          correlationId,
          metadata: {
            changedFields,
            revision: updatedProfile.revision,
          },
        });
      }
    });

    return this.getProfile(userId);
  }
}
