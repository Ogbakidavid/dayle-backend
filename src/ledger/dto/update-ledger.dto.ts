import { PartialType } from '@nestjs/mapped-types';
import { CreateLedgerDto } from './create-ledger.dto';

export class UpdateLedgerDto extends PartialType(CreateLedgerDto) {}
