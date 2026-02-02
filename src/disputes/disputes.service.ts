import { Injectable } from '@nestjs/common';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { UpdateDisputeDto } from './dto/update-dispute.dto';

@Injectable()
export class DisputesService {
  create(createDisputeDto: CreateDisputeDto) {
    return 'This action adds a new dispute';
  }

  findAll() {
    return `This action returns all disputes`;
  }

  findOne(id: number) {
    return `This action returns a #${id} dispute`;
  }

  update(id: number, updateDisputeDto: UpdateDisputeDto) {
    return `This action updates a #${id} dispute`;
  }

  remove(id: number) {
    return `This action removes a #${id} dispute`;
  }
}
