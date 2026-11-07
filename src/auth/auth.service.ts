import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { UsuariosService } from '../usuarios/usuarios.service.js';
import type { UsuarioDocument } from '../usuarios/schemas/usuario.schema.js';
import type { CheckEmailDto, LoginDto, RegisterDto } from './dto/auth.dto.js';
import { ApiException } from '../common/http/api.exception.js';
import { SessoesService } from './sessoes.service.js';

@Injectable()
export class AuthService {
  constructor(
    @Inject(UsuariosService) private readonly usuarios: UsuariosService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(SessoesService) private readonly sessoes: SessoesService,
  ) {}

  async checkEmail({ email }: CheckEmailDto) {
    const usuario = await this.usuarios.findByEmail(email);
    if (!usuario) throw new ApiException('USER_NOT_FOUND');
    const initials = usuario.nome
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase();
    return {
      user: { name: usuario.nome, initials },
    };
  }

  async register({ name, email, password }: RegisterDto) {
    if (await this.usuarios.findByEmail(email)) {
      throw new ApiException('EMAIL_ALREADY_EXISTS');
    }
    const usuario = await this.usuarios.create({
      nome: name,
      email,
      senha_hash: await hash(password, 12),
    });
    return this.authenticate(usuario);
  }

  async login({ email, password }: LoginDto) {
    const usuario = await this.usuarios.findCredentials(email);
    if (!usuario) throw new ApiException('INVALID_CREDENTIALS');
    const valid = await compare(password, usuario.senha_hash);
    if (!valid) {
      throw new ApiException('INVALID_CREDENTIALS');
    }
    return this.authenticate(usuario);
  }

  async me(id: string) {
    const usuario = await this.usuarios.findById(id);
    if (!usuario) throw new ApiException('AUTH_REQUIRED');
    return this.toPublicUser(usuario);
  }

  private async authenticate(usuario: UsuarioDocument) {
    const usuarioId = usuario._id.toString();
    const id = randomBytes(32).toString('base64url');
    const accessToken = await this.jwt.signAsync({ sub: usuarioId, sid: id });
    const payload = this.jwt.decode<{ iat: number; exp: number }>(accessToken);
    if (!payload?.exp || !payload.iat) throw new Error('Invalid signed token');
    await this.sessoes.create(id, usuarioId, new Date(payload.exp * 1000));
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: payload.exp - payload.iat,
      user: this.toPublicUser(usuario),
    };
  }

  private toPublicUser(usuario: UsuarioDocument) {
    return {
      id: usuario._id.toString(),
      name: usuario.nome,
      email: usuario.email,
      username: usuario.username,
      bio: usuario.biografia,
      avatarUrl: usuario.avatar_url,
      createdAt: usuario.criado_em,
    };
  }
}
