import type { DiscountView, ProductType } from '@zed/contracts';
import { apiRequest } from '../api-client';

export const discountsApi = {
  claim: (productType: ProductType) =>
    apiRequest<DiscountView>('/discounts/claim', {
      method: 'POST',
      body: { productType },
      anonymous: true,
    }),
};
