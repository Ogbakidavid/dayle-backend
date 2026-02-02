import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { CreateOnboardingDto } from './dto/create-onboarding.dto';
import { UpdateOnboardingDto } from './dto/update-onboarding.dto';

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Post()
  create(@Body() createOnboardingDto: CreateOnboardingDto) {
    return this.onboardingService.create(createOnboardingDto);
  }

  @Get()
  findAll() {
    return this.onboardingService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.onboardingService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateOnboardingDto: UpdateOnboardingDto) {
    return this.onboardingService.update(+id, updateOnboardingDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.onboardingService.remove(+id);
  }
}
