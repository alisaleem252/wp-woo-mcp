# wp-woo-mcp

An [MCP](https://modelcontextprotocol.io) server for WordPress and WooCommerce. It lets AI assistants and agents read and manage a site through the official REST APIs, with safety defaults built in.

- **Read-only by default.** Writes need an explicit switch.
- **Drafts, not publishes.** New posts and products are created as drafts.
- **No permanent deletes.** Posts go to the trash and can be recovered.
- **Audit log.** Every write is logged as a JSON line on stderr, with before and after values for prices and order status.
- **Least privilege.** Uses WordPress application passwords and WooCommerce API keys, so the server can only do what those credentials allow.

## Tools

| Tool | Type | What it does |
|---|---|---|
| `wp_site_info` | read | Shows what is configured and whether write mode is on |
| `wp_list_posts` | read | List posts, filter by status or search |
| `wp_get_post` | read | Get one post with content |
| `wp_list_pages` | read | List pages |
| `wp_create_post` | write | Create a draft post |
| `wp_update_post` | write | Edit title, content, excerpt (cannot publish) |
| `wp_trash_post` | write | Move a post to the trash |
| `wc_list_products` | read | List products, filter by search, SKU, stock |
| `wc_get_product` | read | Get one product |
| `wc_create_product` | write | Create a draft simple product |
| `wc_update_product` | write | Update price, sale price, stock, description |
| `wc_list_orders` | read | List orders, newest first |
| `wc_get_order` | read | Get one order |
| `wc_update_order_status` | write | Change order status, optional private note |
| `wc_sales_report` | read | Sales totals for a period |

## Setup

### 1. Create credentials

**WordPress:** in wp-admin go to Users, Profile, Application Passwords, and create one. Use a user with only the role you want the agent to have (for example Editor).

**WooCommerce:** go to WooCommerce, Settings, Advanced, REST API, and add a key. Choose **Read** permission unless you plan to enable write mode. Your site must use HTTPS.

### 2. Add it to your MCP client

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "npx",
      "args": ["-y", "wp-woo-mcp"],
      "env": {
        "WP_URL": "https://your-site.com",
        "WP_USER": "your-username",
        "WP_APP_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx",
        "WC_KEY": "ck_...",
        "WC_SECRET": "cs_...",
        "WP_MCP_MODE": "read"
      }
    }
  }
}
```

To run from source instead, use `"command": "node"` and `"args": ["/path/to/wp-woo-mcp/dist/index.js"]`.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `WP_URL` | yes | Site URL, no trailing slash |
| `WP_USER` | for WordPress tools | WordPress username |
| `WP_APP_PASSWORD` | for WordPress tools | Application password |
| `WC_KEY` | for WooCommerce tools | Consumer key |
| `WC_SECRET` | for WooCommerce tools | Consumer secret |
| `WP_MCP_MODE` | no | `read` (default) or `write` |

You can configure only WordPress or only WooCommerce. Tools for the unconfigured side return a clear error.

## Development

```bash
npm install
npm run build
WP_URL=https://your-site.com WP_USER=... WP_APP_PASSWORD=... node dist/index.js
```

To inspect it interactively: `npx @modelcontextprotocol/inspector node dist/index.js`

## Security notes

- Start in `read` mode and a staging site. Switch to `write` only when you trust the workflow.
- Use dedicated credentials for the agent, not an administrator account.
- Treat page and product content as untrusted input. A post on your site could contain text written to manipulate an AI that reads it, so keep write mode off for agents that process content from outside sources.
- Rotate keys if you stop using the server.

## Roadmap

- Media uploads
- Categories, tags and custom post types
- Product variations
- Optional approval step for writes
- Hosted version with team permissions

## License

MIT
