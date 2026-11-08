#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------- Configuration ----------

const WP_URL = (process.env.WP_URL ?? "").replace(/\/+$/, "");
const WP_USER = process.env.WP_USER ?? "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD ?? "";
const WC_KEY = process.env.WC_KEY ?? "";
const WC_SECRET = process.env.WC_SECRET ?? "";
const WRITE_ENABLED = (process.env.WP_MCP_MODE ?? "read").toLowerCase() === "write";

if (!WP_URL) {
  console.error("[wp-woo-mcp] WP_URL is required, e.g. https://example.com");
  process.exit(1);
}

const hasWp = Boolean(WP_USER && WP_APP_PASSWORD);
const hasWc = Boolean(WC_KEY && WC_SECRET);

// ---------- HTTP helpers ----------

type Api = "wp" | "wc";

function authHeader(api: Api): string {
  if (api === "wp") {
    if (!hasWp) throw new Error("WordPress credentials missing: set WP_USER and WP_APP_PASSWORD.");
    return "Basic " + Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString("base64");
  }
  if (!hasWc) throw new Error("WooCommerce credentials missing: set WC_KEY and WC_SECRET.");
  return "Basic " + Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString("base64");
}

async function request(
  api: Api,
  path: string,
  opts: { method?: string; query?: Record<string, unknown>; body?: unknown } = {}
): Promise<any> {
  const base = api === "wp" ? "/wp-json/wp/v2" : "/wp-json/wc/v3";
  const url = new URL(WP_URL + base + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: authHeader(api),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data === "object" && data?.message ? data.message : text.slice(0, 300);
    throw new Error(`${res.status} ${res.statusText}: ${msg}`);
  }
  return data;
}

// ---------- Safety helpers ----------

function requireWrite(action: string): void {
  if (!WRITE_ENABLED) {
    throw new Error(
      `Write mode is off. "${action}" needs WP_MCP_MODE=write in the server environment.`
    );
  }
}

function audit(action: string, detail: Record<string, unknown>): void {
  // stdout is reserved for the MCP protocol, so audit lines go to stderr.
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), site: WP_URL, action, ...detail })
  );
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function wrap<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

const perPage = z.number().int().min(1).max(50).default(10).describe("Results per page (max 50)");
const page = z.number().int().min(1).default(1).describe("Page number");

// ---------- Trimmers (keep responses small for the model) ----------

const trimPost = (p: any) => ({
  id: p.id,
  title: p.title?.rendered ?? p.title,
  status: p.status,
  slug: p.slug,
  link: p.link,
  date: p.date,
  modified: p.modified,
  excerpt: p.excerpt?.rendered,
});

const trimProduct = (p: any) => ({
  id: p.id,
  name: p.name,
  sku: p.sku,
  status: p.status,
  type: p.type,
  price: p.price,
  regular_price: p.regular_price,
  sale_price: p.sale_price,
  stock_status: p.stock_status,
  stock_quantity: p.stock_quantity,
  permalink: p.permalink,
});

const trimOrder = (o: any) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  total: o.total,
  currency: o.currency,
  date_created: o.date_created,
  customer: o.billing
    ? { name: `${o.billing.first_name} ${o.billing.last_name}`.trim(), email: o.billing.email }
    : undefined,
  items: (o.line_items ?? []).map((i: any) => ({
    product_id: i.product_id,
    name: i.name,
    quantity: i.quantity,
    total: i.total,
  })),
});

// ---------- Server ----------

const server = new McpServer({ name: "wp-woo-mcp", version: "0.1.0" });

// ----- WordPress -----

server.registerTool(
  "wp_site_info",
  {
    description:
      "Show which capabilities are configured (WordPress, WooCommerce) and whether write mode is on.",
    inputSchema: {},
  },
  wrap(async () => ({
    site: WP_URL,
    wordpress_configured: hasWp,
    woocommerce_configured: hasWc,
    write_mode: WRITE_ENABLED,
  }))
);

server.registerTool(
  "wp_list_posts",
  {
    description: "List WordPress posts. Optionally filter by status or search text.",
    inputSchema: {
      status: z.enum(["publish", "draft", "pending", "private", "future", "any"]).default("any"),
      search: z.string().optional(),
      per_page: perPage,
      page,
    },
  },
  wrap(async ({ status, search, per_page, page }) => {
    const data = await request("wp", "/posts", { query: { status, search, per_page, page } });
    return data.map(trimPost);
  })
);

server.registerTool(
  "wp_get_post",
  {
    description: "Get one WordPress post, including its content.",
    inputSchema: { id: z.number().int() },
  },
  wrap(async ({ id }) => {
    const p = await request("wp", `/posts/${id}`, { query: { context: "edit" } });
    return { ...trimPost(p), content: p.content?.raw ?? p.content?.rendered };
  })
);

server.registerTool(
  "wp_create_post",
  {
    description:
      "Create a WordPress post. Always created as a draft unless the owner has allowed otherwise. Requires write mode.",
    inputSchema: {
      title: z.string().min(1),
      content: z.string().describe("HTML or block markup"),
      excerpt: z.string().optional(),
    },
  },
  wrap(async ({ title, content, excerpt }) => {
    requireWrite("wp_create_post");
    const p = await request("wp", "/posts", {
      method: "POST",
      body: { title, content, excerpt, status: "draft" },
    });
    audit("wp_create_post", { id: p.id, title });
    return trimPost(p);
  })
);

server.registerTool(
  "wp_update_post",
  {
    description:
      "Update a WordPress post's title, content or excerpt. Cannot publish; publishing is done by a human in wp-admin. Requires write mode.",
    inputSchema: {
      id: z.number().int(),
      title: z.string().optional(),
      content: z.string().optional(),
      excerpt: z.string().optional(),
    },
  },
  wrap(async ({ id, title, content, excerpt }) => {
    requireWrite("wp_update_post");
    const p = await request("wp", `/posts/${id}`, {
      method: "POST",
      body: { title, content, excerpt },
    });
    audit("wp_update_post", { id, fields: Object.keys({ title, content, excerpt }).filter(
      (k) => ({ title, content, excerpt } as any)[k] !== undefined
    ) });
    return trimPost(p);
  })
);

server.registerTool(
  "wp_trash_post",
  {
    description:
      "Move a WordPress post to the trash (recoverable). Never permanently deletes. Requires write mode.",
    inputSchema: { id: z.number().int() },
  },
  wrap(async ({ id }) => {
    requireWrite("wp_trash_post");
    const p = await request("wp", `/posts/${id}`, { method: "DELETE" });
    audit("wp_trash_post", { id });
    return { trashed: true, id: p?.id ?? id };
  })
);

server.registerTool(
  "wp_list_pages",
  {
    description: "List WordPress pages.",
    inputSchema: {
      status: z.enum(["publish", "draft", "pending", "private", "any"]).default("any"),
      search: z.string().optional(),
      per_page: perPage,
      page,
    },
  },
  wrap(async ({ status, search, per_page, page }) => {
    const data = await request("wp", "/pages", { query: { status, search, per_page, page } });
    return data.map(trimPost);
  })
);

// ----- WooCommerce -----

server.registerTool(
  "wc_list_products",
  {
    description: "List WooCommerce products. Filter by search text, SKU or stock status.",
    inputSchema: {
      search: z.string().optional(),
      sku: z.string().optional(),
      stock_status: z.enum(["instock", "outofstock", "onbackorder"]).optional(),
      status: z.enum(["publish", "draft", "pending", "private", "any"]).default("any"),
      per_page: perPage,
      page,
    },
  },
  wrap(async ({ search, sku, stock_status, status, per_page, page }) => {
    const data = await request("wc", "/products", {
      query: { search, sku, stock_status, status, per_page, page },
    });
    return data.map(trimProduct);
  })
);

server.registerTool(
  "wc_get_product",
  {
    description: "Get one WooCommerce product with its description.",
    inputSchema: { id: z.number().int() },
  },
  wrap(async ({ id }) => {
    const p = await request("wc", `/products/${id}`);
    return {
      ...trimProduct(p),
      description: p.description,
      short_description: p.short_description,
      categories: (p.categories ?? []).map((c: any) => c.name),
    };
  })
);

server.registerTool(
  "wc_create_product",
  {
    description:
      "Create a simple WooCommerce product as a draft. Requires write mode.",
    inputSchema: {
      name: z.string().min(1),
      regular_price: z.string().describe("Price as a string, e.g. \"19.99\""),
      description: z.string().optional(),
      sku: z.string().optional(),
      stock_quantity: z.number().int().min(0).optional(),
    },
  },
  wrap(async ({ name, regular_price, description, sku, stock_quantity }) => {
    requireWrite("wc_create_product");
    const p = await request("wc", "/products", {
      method: "POST",
      body: {
        name,
        type: "simple",
        status: "draft",
        regular_price,
        description,
        sku,
        manage_stock: stock_quantity !== undefined,
        stock_quantity,
      },
    });
    audit("wc_create_product", { id: p.id, name });
    return trimProduct(p);
  })
);

server.registerTool(
  "wc_update_product",
  {
    description:
      "Update a WooCommerce product's price, sale price, stock or description. Cannot change publish status. Requires write mode.",
    inputSchema: {
      id: z.number().int(),
      regular_price: z.string().optional(),
      sale_price: z.string().optional().describe("Empty string clears the sale price"),
      stock_quantity: z.number().int().min(0).optional(),
      description: z.string().optional(),
    },
  },
  wrap(async ({ id, regular_price, sale_price, stock_quantity, description }) => {
    requireWrite("wc_update_product");
    const body: Record<string, unknown> = {};
    if (regular_price !== undefined) body.regular_price = regular_price;
    if (sale_price !== undefined) body.sale_price = sale_price;
    if (description !== undefined) body.description = description;
    if (stock_quantity !== undefined) {
      body.manage_stock = true;
      body.stock_quantity = stock_quantity;
    }
    if (Object.keys(body).length === 0) throw new Error("Nothing to update.");
    const before = await request("wc", `/products/${id}`);
    const p = await request("wc", `/products/${id}`, { method: "PUT", body });
    audit("wc_update_product", {
      id,
      changes: body,
      before: {
        regular_price: before.regular_price,
        sale_price: before.sale_price,
        stock_quantity: before.stock_quantity,
      },
    });
    return trimProduct(p);
  })
);

server.registerTool(
  "wc_list_orders",
  {
    description: "List WooCommerce orders, newest first. Filter by status.",
    inputSchema: {
      status: z
        .enum([
          "any",
          "pending",
          "processing",
          "on-hold",
          "completed",
          "cancelled",
          "refunded",
          "failed",
        ])
        .default("any"),
      per_page: perPage,
      page,
    },
  },
  wrap(async ({ status, per_page, page }) => {
    const data = await request("wc", "/orders", {
      query: { status, per_page, page, orderby: "date", order: "desc" },
    });
    return data.map(trimOrder);
  })
);

server.registerTool(
  "wc_get_order",
  {
    description: "Get one WooCommerce order.",
    inputSchema: { id: z.number().int() },
  },
  wrap(async ({ id }) => trimOrder(await request("wc", `/orders/${id}`)))
);

server.registerTool(
  "wc_update_order_status",
  {
    description:
      "Change a WooCommerce order's status (for example processing to completed). Cannot refund. Requires write mode.",
    inputSchema: {
      id: z.number().int(),
      status: z.enum(["pending", "processing", "on-hold", "completed", "cancelled"]),
      note: z.string().optional().describe("Optional private note added to the order"),
    },
  },
  wrap(async ({ id, status, note }) => {
    requireWrite("wc_update_order_status");
    const before = await request("wc", `/orders/${id}`);
    const o = await request("wc", `/orders/${id}`, { method: "PUT", body: { status } });
    if (note) {
      await request("wc", `/orders/${id}/notes`, {
        method: "POST",
        body: { note, customer_note: false },
      });
    }
    audit("wc_update_order_status", { id, from: before.status, to: status });
    return trimOrder(o);
  })
);

server.registerTool(
  "wc_sales_report",
  {
    description: "Sales totals for a period. Uses WooCommerce's reports endpoint.",
    inputSchema: {
      period: z.enum(["week", "month", "last_month", "year"]).default("month"),
    },
  },
  wrap(async ({ period }) => {
    const data = await request("wc", "/reports/sales", { query: { period } });
    const r = Array.isArray(data) ? data[0] : data;
    return {
      period,
      total_sales: r?.total_sales,
      net_sales: r?.net_sales,
      total_orders: r?.total_orders,
      total_items: r?.total_items,
      total_refunds: r?.total_refunds,
    };
  })
);

// ---------- Start ----------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[wp-woo-mcp] ready for ${WP_URL} (wordpress: ${hasWp}, woocommerce: ${hasWc}, write: ${WRITE_ENABLED})`
);
