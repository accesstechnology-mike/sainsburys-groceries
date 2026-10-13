import { GroceriesClient } from "../api/client.ts";
import { SainsburysError } from "../errors.ts";
import type { OrderSummary } from "../types.ts";

export interface OrderItemHit {
  name: string;
  quantity: number;
  uom?: string;
  sub_total?: number;
  uid?: string;
}

export interface OrderItemsResult {
  order: OrderSummary;
  items: OrderItemHit[];
}

function normalise(order: Record<string, unknown>): OrderSummary {
  return {
    id: String(order.order_uid ?? order.id ?? "?"),
    status: String(order.status ?? ""),
    delivery_date: (order.slot_start_time as string) ?? undefined,
    delivery_slot:
      order.slot_start_time && order.slot_end_time
        ? `${String(order.slot_start_time).slice(0, 16).replace("T", " ")} → ${String(order.slot_end_time).slice(11, 16)}`
        : undefined,
    total: Number(order.total ?? NaN),
    amendable: Boolean(order.is_in_amend_mode) || Boolean(order.is_cancellable),
    raw: order,
  };
}

function asOrderList(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object" && Array.isArray((data as { orders?: unknown }).orders)) {
    return (data as { orders: Record<string, unknown>[] }).orders;
  }
  throw new SainsburysError("site_changed", "Order list was not an array or {orders: array}.");
}

export async function getOrders(
  client: GroceriesClient,
  opts: { pageSize?: number; pageNumber?: number } = {},
): Promise<{ orders: OrderSummary[]; via: "http" }> {
  const page = await client.getOrders(opts.pageSize ?? 10, opts.pageNumber ?? 1);
  return { orders: asOrderList(page).map(normalise), via: "http" };
}

export async function getLatestOrder(client: GroceriesClient): Promise<OrderSummary> {
  const { orders } = await getOrders(client, { pageSize: 1 });
  const latest = orders[0];
  if (!latest || latest.id === "?") throw new SainsburysError("site_changed", "No orders were returned for this account.");
  return latest;
}

export async function getOrderDetailFull(
  client: GroceriesClient,
  uid: string,
): Promise<{ summary: OrderSummary; detail: Record<string, unknown> }> {
  const detail = await client.getOrderDetail(uid);
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new SainsburysError("site_changed", `Order ${uid} detail was not an object.`);
  }
  if (detail.order_uid == null && detail.id == null && !Array.isArray(detail.order_items)) {
    throw new SainsburysError("site_changed", `Order ${uid} detail had no order id and no order_items.`);
  }
  return { summary: normalise(detail), detail };
}

export async function findInOrders(
  client: GroceriesClient,
  query: string,
  opts: { maxPages?: number } = {},
): Promise<{ matches: OrderItemsResult[]; scanned: number; via: "http" }> {
  const needle = query.toLowerCase().trim();
  const maxPages = opts.maxPages ?? 3;
  let scanned = 0;
  const matches: OrderItemsResult[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { orders } = await getOrders(client, { pageNumber: page, pageSize: 10 });
    if (!orders.length) break;
    for (const order of orders) {
      scanned++;
      const { detail } = await getOrderDetailFull(client, order.id);
      const items = Array.isArray(detail.order_items) ? (detail.order_items as Record<string, unknown>[]) : [];
      const hits: OrderItemHit[] = items
        .filter((item) => {
          const product = item.product as { name?: string } | undefined;
          return String(product?.name ?? "").toLowerCase().includes(needle);
        })
        .map((item) => {
          const product = item.product as { name?: string; product_uid?: string } | undefined;
          return {
            name: String(product?.name ?? "?"),
            quantity: Number(item.quantity ?? 0),
            uom: item.uom as string | undefined,
            sub_total: Number(item.sub_total ?? NaN),
            uid: String(product?.product_uid ?? ""),
          };
        });
      if (hits.length) matches.push({ order, items: hits });
    }
    if (orders.length < 10) break;
  }
  return { matches, scanned, via: "http" };
}
