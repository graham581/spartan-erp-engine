import { SubmittableDocument } from '../runtime/document';
import { ValidationError } from '../runtime/errors';
import type { SalesOrder as SalesOrderDoc, SalesOrderItem } from '../../generated/types';

type Loose<T> = Partial<T> & Record<string, unknown>;

/**
 * Sales Order controller. A faithful SUBSET of ERPNext's SalesOrder.validate()
 * (selling/doctype/sales_order/sales_order.py) — the rules that matter for a
 * working order; taxes/pricing/reservation/billing-status are deferred.
 */
export class SalesOrder extends SubmittableDocument {
  private get d(): Loose<SalesOrderDoc> {
    return this.doc as Loose<SalesOrderDoc>;
  }

  private get lines(): Array<Loose<SalesOrderItem>> {
    return ((this.doc.items as unknown[]) ?? []) as Array<Loose<SalesOrderItem>>;
  }

  async validate(): Promise<void> {
    const d = this.d;

    if (!d.customer) throw new ValidationError('Customer is required');
    if (!d.company) throw new ValidationError('Company is required');

    if (this.lines.length === 0) {
      throw new ValidationError('Sales Order must have at least one item');
    }
    this.lines.forEach((it, i) => {
      if (!it.item_code) throw new ValidationError(`Row ${i + 1}: Item Code is required`);
      const qty = Number(it.qty ?? 0);
      if (!(qty > 0)) throw new ValidationError(`Row ${i + 1}: Qty must be greater than 0`);
    });

    // validate_delivery_date (subset): delivery cannot precede the order date
    if (d.delivery_date && d.transaction_date && String(d.delivery_date) < String(d.transaction_date)) {
      throw new ValidationError('Delivery Date cannot be before Transaction Date');
    }

    // set_missing_values (subset)
    if (d.conversion_rate == null) d.conversion_rate = 1;
    if (!d.status) d.status = 'Draft';

    this.calculateTotals();
  }

  async beforeSubmit(): Promise<void> {
    // ERPNext sets this from delivery/billing state; pre-fulfilment it is this.
    this.d.status = 'To Deliver and Bill';
    this.d.per_delivered = 0;
    this.d.per_billed = 0;
  }

  async beforeCancel(): Promise<void> {
    this.d.status = 'Cancelled';
  }

  /** Line amount + header totals. No taxes/discount yet (deferred to Accounts). */
  private calculateTotals(): void {
    let totalQty = 0;
    let total = 0;
    for (const it of this.lines) {
      const qty = Number(it.qty ?? 0);
      const rate = Number(it.rate ?? 0);
      const amount = qty * rate;
      it.amount = amount;
      totalQty += qty;
      total += amount;
    }
    const d = this.d;
    d.total_qty = totalQty;
    d.total = total;
    d.net_total = total;
    d.grand_total = total;
    d.rounded_total = Math.round(total);
  }
}
