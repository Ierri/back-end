import { Reflector } from '@nestjs/core';

export const ResponseMessage = Reflector.createDecorator<string>();
