import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  addToCartSchema,
  updateCartItemSchema,
  type AddToCartInput,
  type UpdateCartItemInput,
} from '@zed/contracts';
import { CartService } from './cart.service';
import { zodBody } from '../common/zod-validation.pipe';
import { CurrentUser } from '../common/current-user.decorator';

@ApiTags('cart')
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  get(@CurrentUser('id') userId: string) {
    return this.cart.getView(userId);
  }

  @Post('items')
  add(
    @CurrentUser('id') userId: string,
    @Body(zodBody(addToCartSchema)) dto: AddToCartInput,
  ) {
    return this.cart.add(userId, dto);
  }

  @Patch('items/:itemId')
  update(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body(zodBody(updateCartItemSchema)) dto: UpdateCartItemInput,
  ) {
    return this.cart.updateQuantity(userId, itemId, dto.quantity);
  }

  @Delete('items/:itemId')
  remove(@CurrentUser('id') userId: string, @Param('itemId') itemId: string) {
    return this.cart.remove(userId, itemId);
  }
}
