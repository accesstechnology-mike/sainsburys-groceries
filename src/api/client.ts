import { API_BASE } from "../config.ts";
import { classifyResponse } from "./classify.ts";
import { ApiError, NoSessionError, SainsburysError } from "../errors.ts";
import type { Transport } from "./transport.ts";
import type {
  Basket,
  Product,
  Reservation,
  SearchResponse,
  Session,
} from "../types.ts";

export { ApiError, NoSessionError } from "../errors.ts";
export type { Transport } from "./transport.ts";

interface ClientOptions {
  session: Session | null;
  transport: Transport;
}

function tomorrowIso(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

export class GroceriesClient {
  readonly session: Session | null;
  private transport: Transport;

  constructor(opts: ClientOptions) {
    this.session = opts.session;
    this.transport = opts.transport;
  }

  requireSession(): Session {
    if (!this.session) throw new NoSessionError();
    return this.session;
  }

  basketParams(slotBooked?: boolean, pickTime?: string, storeNumber?: string): string {
    const params = new URLSearchParams({
      pick_time: pickTime ?? tomorrowIso(),
      store_number: storeNumber ?? "0560",
      slot_booked: String(slotBooked ?? false),
    });
    return params.toString();
  }

  async request<T = unknown>(
    method: string,
    pathOrUrl: string,
    opts: {
      query?: Record<string, string>;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
    const u = new URL(url);
    if (opts.query) for (const [k, v] of Object.entries(opts.query)) u.searchParams.set(k, v);

    const res = await this.transport.request(method, u.toString(), {
      body: opts.body,
      headers: opts.headers,
    });

    const classified = classifyResponse(res.status, u.toString(), res.text);
    if (classified) throw classified;
    if (res.status >= 300 && res.status < 400) {
      throw new SainsburysError(
        "session_expired",
        `HTTP ${res.status} from ${u.pathname}. A redirect here means the groceries session is not signed in.`,
      );
    }
    if (!res.text) return {} as T;
    try {
      return JSON.parse(res.text) as T;
    } catch {
      throw new ApiError(res.status, u.toString(), "non-JSON response", res.text.slice(0, 500));
    }
  }

  // ---- products -------------------------------------------------------------

  searchProducts(query: string, pageNumber = 1, pageSize = 24): Promise<SearchResponse> {
    return this.request<SearchResponse>("GET", "/product/v1/product", {
      query: {
        "filter[keyword]": query,
        page_number: String(pageNumber),
        page_size: String(pageSize),
      },
    });
  }

  /** Search works unauthenticated; sku-looking inputs skip the lookup. */
  async resolveProduct(queryOrSku: string): Promise<Product> {
    if (/^\d{6,8}$/.test(queryOrSku)) {
      return { product_uid: queryOrSku, name: queryOrSku };
    }
    const res = await this.searchProducts(queryOrSku, 1, 10);
    const inStock = res.products?.filter((p) => p.in_stock !== false) ?? [];
    const first = inStock[0] ?? res.products?.[0];
    if (!first?.product_uid) throw new Error(`No product found for "${queryOrSku}"`);
    return first;
  }

  // ---- customer ---------------------------------------------------------------

  /**
   * NOTE: anonymous users get HTTP 200 with a guest payload (user_id like
   * -1002) on authed endpoints, so "ok" must be judged by content.
   */
  async getProfile(): Promise<Record<string, unknown>> {
    const profile = await this.request<Record<string, unknown>>("GET", "/customer/v1/customer/profile");
    const userId = Number(profile?.user_id ?? 0);
    if (!profile || Object.keys(profile).length === 0 || !Number.isFinite(userId) || userId <= 0) {
      throw new NoSessionError();
    }
    return profile;
  }

  // ---- basket -----------------------------------------------------------------

  async getBasket(slotBooked = false): Promise<Basket> {
    const b = await this.request<Basket>("GET", `/basket/v2/basket?${this.basketParams(slotBooked)}`);
    return b ?? {};
  }

  async addToBasket(productUid: string, quantity: number, uom = "ea", slotBooked = false): Promise<Basket> {
    const basket = await this.request<Basket>("POST", `/basket/v2/basket/item?${this.basketParams(slotBooked)}`, {
      body: { product_uid: productUid, quantity, uom, selected_catchweight: "" },
    });
    return assertBasketMutation(basket);
  }

  async updateBasketItem(itemUid: string, quantity: number, slotBooked = false): Promise<Basket> {
    const basket = await this.request<Basket>(
      "PUT",
      `/basket/v2/basket/items/${itemUid}?${this.basketParams(slotBooked)}`,
      { body: { quantity } },
    );
    return assertBasketMutation(basket);
  }

  async removeBasketItem(itemUid: string, slotBooked = false): Promise<Basket> {
    const basket = await this.request<Basket>(
      "DELETE",
      `/basket/v2/basket/item/${itemUid}?${this.basketParams(slotBooked)}`,
    );
    return assertBasketMutation(basket);
  }

  // ---- slots ------------------------------------------------------------------

  getReservation(): Promise<Reservation> {
    return this.request("GET", "/slot/v1/slot/reservation");
  }

  async hasBookedSlot(): Promise<boolean> {
    try {
      const r = await this.getReservation();
      const t = r?.reservation_type ? String(r.reservation_type) : "";
      return Boolean(r?.slot) || !!t && !/none/i.test(t);
    } catch {
      return false;
    }
  }

  getDeliveryInformation(): Promise<Record<string, unknown>> {
    return this.request("GET", "/slot/v1/slot/delivery-information");
  }

  listSlotsDirect(query: Record<string, string>): Promise<unknown> {
    return this.request("GET", "/slot/v1/slots", { query });
  }

  bookSlotDirect(slotId: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    return this.request("POST", "/slot/v1/slot/reservation", {
      body: { ...extra, slot_id: slotId },
    });
  }

  cancelReservation(): Promise<unknown> {
    return this.request("DELETE", "/slot/v1/slot/reservation");
  }

  // ---- orders -----------------------------------------------------------------

  /**
   * Order listing. The transport sends the session cookie, wcauthtoken, and
   * bearer token when they exist. Whether that is enough without a browser
   * has not been checked on a live authenticated session.
   */
  async getOrders(
    pageSize = 10,
    pageNumber = 1,
    headers?: Record<string, string>,
  ): Promise<{ orders: Record<string, unknown>[] }> {
    const data = await this.request<unknown>("GET", "/order/v1/order", {
      query: { page_size: String(pageSize), page_number: String(pageNumber) },
      headers,
    });
    const orders = Array.isArray(data)
      ? (data as Record<string, unknown>[])
      : ((data as any)?.orders ?? []);
    return { orders };
  }

  /** Full detail for one order, incl. order_items[] (same header requirement). */
  getOrderDetail(uid: string, headers?: Record<string, string>): Promise<Record<string, unknown>> {
    return this.request("GET", `/order/v1/order/${uid}`, { headers });
  }
}

function assertBasketMutation(data: Basket): Basket {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new SainsburysError(
      "site_changed",
      "Basket mutation returned an unexpected shape. No further basket change was attempted.",
    );
  }
  if (!Array.isArray(data.items) && data.basket_id == null && data.order_id == null) {
    throw new SainsburysError(
      "site_changed",
      "Basket mutation response had neither items nor basket_id nor order_id. No further basket change was attempted.",
    );
  }
  return data;
}
