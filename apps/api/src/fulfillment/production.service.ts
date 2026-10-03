import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ProductionTicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';

const TICKET_TRANSITIONS: Record<ProductionTicketStatus, readonly ProductionTicketStatus[]> = {
  QUEUED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

@Injectable()
export class ProductionService {
  private readonly logger = new Logger(ProductionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  async listQueue(status?: ProductionTicketStatus) {
    return this.prisma.productionTicket.findMany({
      where: status ? { status } : { status: { in: ['QUEUED', 'IN_PROGRESS'] } },
      include: {
        orderItem: {
          include: { order: { select: { orderNumber: true, id: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async setStatus(
    ticketId: string,
    status: ProductionTicketStatus,
    actorUserId: string,
  ): Promise<void> {
    const ticket = await this.prisma.productionTicket.findUnique({
      where: { id: ticketId },
      include: { orderItem: true },
    });
    if (!ticket) throw new NotFoundException('Production ticket not found');

    if (!TICKET_TRANSITIONS[ticket.status].includes(status)) {
      throw new BadRequestException(`Cannot move ticket from ${ticket.status} to ${status}`);
    }

    await this.prisma.productionTicket.update({
      where: { id: ticketId },
      data: {
        status,
        assignedTo: actorUserId,
        ...(status === 'IN_PROGRESS' ? { startedAt: new Date() } : {}),
        ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}),
      },
    });

    this.logger.log(`Ticket ${ticketId} (order item ${ticket.orderItemId}) -> ${status}`);

    if (status === 'COMPLETED') {
      await this.checkOrderReady(ticket.orderItem.orderId);
    }
  }

  private async checkOrderReady(orderId: string): Promise<void> {
    const tickets = await this.prisma.productionTicket.findMany({
      where: { orderItem: { orderId } },
    });

    const allDone = tickets.every((t) => t.status === 'COMPLETED' || t.status === 'CANCELLED');
    if (!allDone) return;

    this.logger.log(`All production tickets complete for order ${orderId}; releasing to shipping`);
    await this.orders.releaseForShipment(orderId);
  }
}
