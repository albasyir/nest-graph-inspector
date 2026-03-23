import { Controller } from '@nestjs/common';
import { UserDeprecatedService } from './user-deprecated.service';

@Controller('user-deprecated')
export class UserDeprecatedController {
  constructor(private readonly userDeprecatedService: UserDeprecatedService) {}
}
