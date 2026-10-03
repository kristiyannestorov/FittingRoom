import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentProviderKey } from '@zed/contracts';
import type { Env } from '../config/configuration';
import {
  PAYMENT_PROVIDERS_TOKEN,
  type PaymentProvider,
} from './payment-provider.interface';

@Injectable()
export class PaymentProviderRegistry {
  private readonly byKey: Map<PaymentProviderKey, PaymentProvider>;

  constructor(
    @Inject(PAYMENT_PROVIDERS_TOKEN) providers: PaymentProvider[],
    private readonly config: ConfigService<Env, true>,
  ) {
    this.byKey = new Map(providers.map((provider) => [provider.key, provider]));
  }

  get(key: PaymentProviderKey): PaymentProvider {
    const provider = this.byKey.get(key);
    if (!provider) {
      throw new BadRequestException(`Payment provider ${key} is not configured`);
    }
    return provider;
  }

  default(): PaymentProvider {
    const key = this.config
      .get('DEFAULT_PAYMENT_PROVIDER', { infer: true })
      .toUpperCase() as PaymentProviderKey;
    return this.get(key);
  }

  available(): PaymentProviderKey[] {
    return [...this.byKey.keys()];
  }
}
