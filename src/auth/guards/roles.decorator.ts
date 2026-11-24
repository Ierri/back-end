import { SetMetadata } from '@nestjs/common';
import type { Usuario } from '../../usuarios/schemas/usuario.schema.js';

export const REQUIRED_ROLES = 'required_roles';
export const Roles = (...roles: Usuario['papeis']) => SetMetadata(REQUIRED_ROLES, roles);
