import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ShippingProviderKey } from '@zed/contracts';
import {
  SHIPPING_PROVIDERS_TOKEN,
  type ShippingProvider,
} from './shipping-provider.interface';

@Injectable()
export class ShippingProviderRegistry {
  private readonly byKey: Map<ShippingProviderKey, ShippingProvider>;

  constructor(@Inject(SHIPPING_PROVIDERS_TOKEN) providers: ShippingProvider[]) {
    this.byKey = new Map(providers.map((provider) => [provider.key, provider]));
  }

  get(key: ShippingProviderKey): ShippingProvider {
    const provider = this.byKey.get(key);
    if (!provider) {
      throw new BadRequestException(`Shipping provider ${key} is not configured`);
    }
    return provider;
  }

  all(): ShippingProvider[] {
    return [...this.byKey.values()];
  }
}
